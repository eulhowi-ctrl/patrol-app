#!/usr/bin/env python3
"""2단계 이진 분류기 학습 (사람 크롭 입력) — 안전그네, 소매/바지 길이 등에 공용.

입력 데이터 구조(ImageFolder): {data_dir}/{train,val,test}/{0,1}/*.jpg
MobileNetV3-Small(ImageNet 사전학습) 마지막 레이어만 교체해 파인튜닝 —
탐지(YOLO)보다 훨씬 가벼워 CPU에서도 에폭당 수 분 내로 끝난다.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from torchvision import datasets, models, transforms


def build_model(num_classes: int = 2) -> nn.Module:
    model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.IMAGENET1K_V1)
    in_features = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(in_features, num_classes)
    return model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, help="ImageFolder 루트 (train/val/test 하위 포함)")
    ap.add_argument("--out-name", required=True, help="출력 파일 접두어 (예: harness, clothing)")
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--imgsz", type=int, default=160)
    ap.add_argument("--lr", type=float, default=1e-3)
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    out_dir = Path(__file__).parent / "runs" / args.out_name
    out_dir.mkdir(parents=True, exist_ok=True)

    train_tf = transforms.Compose([
        transforms.Resize((args.imgsz, args.imgsz)),
        transforms.RandomHorizontalFlip(),
        transforms.ColorJitter(0.2, 0.2, 0.2),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    eval_tf = transforms.Compose([
        transforms.Resize((args.imgsz, args.imgsz)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])

    train_ds = datasets.ImageFolder(data_dir / "train", transform=train_tf)
    val_ds = datasets.ImageFolder(data_dir / "val", transform=eval_tf)
    print("classes(폴더순=인덱스순):", train_ds.classes)

    train_loader = DataLoader(train_ds, batch_size=args.batch, shuffle=True, num_workers=2)
    val_loader = DataLoader(val_ds, batch_size=args.batch, shuffle=False, num_workers=2)

    device = torch.device("cpu")
    model = build_model(num_classes=len(train_ds.classes)).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    criterion = nn.CrossEntropyLoss()

    best_acc = 0.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        total_loss = 0.0
        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            optimizer.zero_grad()
            out = model(x)
            loss = criterion(out, y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item() * x.size(0)
        train_loss = total_loss / len(train_ds)

        model.eval()
        correct = 0
        with torch.no_grad():
            for x, y in val_loader:
                x, y = x.to(device), y.to(device)
                pred = model(x).argmax(dim=1)
                correct += (pred == y).sum().item()
        val_acc = correct / len(val_ds)
        print(f"[{args.out_name}] epoch {epoch}/{args.epochs} train_loss={train_loss:.4f} val_acc={val_acc:.4f}", flush=True)

        if val_acc >= best_acc:
            best_acc = val_acc
            torch.save(model.state_dict(), out_dir / "best.pt")

    print(f"[{args.out_name}] 최고 val_acc={best_acc:.4f}")

    # ONNX export (best 가중치 로드 후)
    model.load_state_dict(torch.load(out_dir / "best.pt", map_location="cpu"))
    model.eval()
    dummy = torch.randn(1, 3, args.imgsz, args.imgsz)
    onnx_path = out_dir / f"{args.out_name}.onnx"
    torch.onnx.export(
        model, dummy, str(onnx_path),
        input_names=["input"], output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=12,
    )
    to_single_file(onnx_path)
    print(f"[{args.out_name}] ONNX export 완료: {onnx_path} ({onnx_path.stat().st_size / 1e6:.1f}MB)")
    verify_onnx(model, onnx_path, data_dir / "test", eval_tf, args.out_name)


def to_single_file(onnx_path: Path) -> None:
    """가중치를 .onnx 한 파일에 합친다.

    최신 torch는 가중치를 `<이름>.onnx.data`로 따로 저장할 수 있는데, 앱(web/public/models)에는
    .onnx만 올라가 2026-10 복장 모델 3개가 로드 실패했었다. 작은 모델이라 한 파일이 안전하다.
    """
    import onnx

    m = onnx.load(str(onnx_path))  # 외부 가중치 파일이 있으면 함께 읽음
    onnx.save_model(m, str(onnx_path), save_as_external_data=False)
    sidecar = onnx_path.with_name(onnx_path.name + ".data")
    if sidecar.exists():
        sidecar.unlink()
    check = onnx.load(str(onnx_path), load_external_data=False)
    ext = [t.name for t in check.graph.initializer if t.data_location == onnx.TensorProto.EXTERNAL]
    assert not ext, f"외부 가중치가 남아 있음: {ext[:3]}"


def verify_onnx(model: nn.Module, onnx_path: Path, test_dir: Path, eval_tf, name: str) -> None:
    """앱과 같은 런타임(onnxruntime)으로 열어 PyTorch와 출력이 같은지, 테스트 정확도는 얼마인지 확인."""
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name
    test_ds = datasets.ImageFolder(test_dir, transform=eval_tf)
    loader = DataLoader(test_ds, batch_size=32, shuffle=False)
    correct = 0
    max_diff = 0.0
    with torch.no_grad():
        for x, y in loader:
            ref = model(x)
            out = torch.from_numpy(sess.run(None, {in_name: x.numpy()})[0])
            max_diff = max(max_diff, (out - ref).abs().max().item())
            correct += (out.argmax(dim=1) == y).sum().item()
    acc = correct / len(test_ds)
    print(f"[{name}] ONNX 검증: test_acc={acc:.4f} (n={len(test_ds)}), PyTorch 대비 최대 오차={max_diff:.2e}", flush=True)
    assert max_diff < 1e-3, "ONNX 출력이 PyTorch와 다름"


if __name__ == "__main__":
    main()
