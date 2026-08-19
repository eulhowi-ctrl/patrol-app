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
    print(f"[{args.out_name}] ONNX export 완료: {onnx_path}")


if __name__ == "__main__":
    main()
