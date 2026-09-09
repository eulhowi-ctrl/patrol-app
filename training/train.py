#!/usr/bin/env python3
"""1단계 YOLO 탐지기 파인튜닝 (no_helmet/no_vest/no_safety_glasses/no_mask/fire_smoke/man_down).

전제: training/merge_datasets.py를 먼저 실행해 training/merged_yolo/data.yaml이 있어야 함.
CPU 전용 환경(GPU 없음) 기준 하이퍼파라미터 — YOLOv8 Nano, 작은 imgsz로 속도 확보.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=200)  # 보호구 전체 강화: 40 → 200
    ap.add_argument("--imgsz", type=int, default=384)
    ap.add_argument("--batch", type=int, default=8)     # CPU 극한 최적화: 32 → 8
    ap.add_argument("--workers", type=int, default=1)   # 워커 1로 줄임
    args = ap.parse_args()

    data_yaml = ROOT / "merged_yolo" / "data.yaml"
    if not data_yaml.exists():
        raise SystemExit(f"{data_yaml} 없음 — 먼저 python merge_datasets.py 실행")

    # v2: 보강된 데이터셋(no_helmet 6배 증가) + 상향된 하이퍼파라미터로 새로 학습.
    # 기존 runs/patrol_detector(이전 학습 결과)는 건드리지 않고 별도 런으로 분리.
    run_name = "patrol_detector_v2"
    run_dir = ROOT / "runs" / run_name
    last_pt = run_dir / "weights" / "last.pt"
    done_marker = run_dir / "TRAINING_DONE"

    if done_marker.exists():
        print(f"이미 완료된 학습입니다 ({done_marker}). 다시 하려면 이 파일을 지우세요.")
        return

    if last_pt.exists():
        # watchdog이 재시작한 경우 — 중단된 지점(last.pt)에서 이어서 학습
        print(f"중단된 학습 발견, 이어서 진행: {last_pt}")
        model = YOLO(str(last_pt))
        model.train(resume=True)
    else:
        model = YOLO("yolov8n.pt")
        model.train(
            data=str(data_yaml),
            epochs=args.epochs,
            imgsz=args.imgsz,
            batch=args.batch,
            workers=args.workers,
            device="cpu",
            project=str(ROOT / "runs"),
            name=run_name,
            patience=20,
            exist_ok=True,
            optimizer="SGD",  # ARM bf16 호환성: MuSGD → SGD
        )

    best = run_dir / "weights" / "best.pt"
    print(f"학습 완료. best 가중치: {best}")

    # ONNX export
    m = YOLO(str(best))
    onnx_path = m.export(format="onnx", imgsz=args.imgsz)
    print(f"ONNX export 완료: {onnx_path}")

    done_marker.write_text(f"onnx={onnx_path}\n", encoding="utf-8")


if __name__ == "__main__":
    main()
