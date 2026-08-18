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
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--imgsz", type=int, default=256)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()

    data_yaml = ROOT / "merged_yolo" / "data.yaml"
    if not data_yaml.exists():
        raise SystemExit(f"{data_yaml} 없음 — 먼저 python merge_datasets.py 실행")

    model = YOLO("yolov8n.pt")
    model.train(
        data=str(data_yaml),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        workers=args.workers,  # CPU 2코어 — 데이터 로딩을 학습과 병렬화(기본값 0이면 완전 직렬)
        device="cpu",
        project=str(ROOT / "runs"),
        name="patrol_detector",
        patience=15,  # 15에폭 개선 없으면 조기 종료
        exist_ok=True,
    )

    best = ROOT / "runs" / "patrol_detector" / "weights" / "best.pt"
    print(f"학습 완료. best 가중치: {best}")

    # ONNX export
    m = YOLO(str(best))
    onnx_path = m.export(format="onnx", imgsz=args.imgsz)
    print(f"ONNX export 완료: {onnx_path}")


if __name__ == "__main__":
    main()
