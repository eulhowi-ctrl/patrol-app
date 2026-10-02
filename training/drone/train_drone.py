#!/usr/bin/env python3
"""드론(항공 시점) 사람·차량 탐지기 파인튜닝 — 갤럭시 폰 온디바이스 추론용.

전제: training/drone/prepare_visdrone.py를 먼저 실행해 visdrone_yolo/data.yaml이 있어야 함.
항공 영상은 사람이 수~수십 픽셀로 작아서 지상용 탐지기(imgsz 256~384)보다 큰 입력이
필요하다 — 기본 640. COCO 사전학습 YOLOv8n에서 시작(person/car/truck/bus/motorcycle
모두 COCO에 있는 클래스라 전이가 잘 됨). GPU 없는 CPU 환경 기준.

중간에 죽어도(세션 종료 등) 같은 명령을 다시 실행하면 last.pt에서 이어서 학습한다.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(__file__).parent
RUN_NAME = "drone_detector_v1"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=50)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()

    data_yaml = ROOT / "visdrone_yolo" / "data.yaml"
    if not data_yaml.exists():
        raise SystemExit(f"{data_yaml} 없음 — 먼저 python prepare_visdrone.py 실행")

    last = ROOT / "runs" / RUN_NAME / "weights" / "last.pt"
    if last.exists():
        print(f"이전 학습 이어서 진행: {last}")
        YOLO(str(last)).train(resume=True)
    else:
        YOLO("yolov8n.pt").train(
            data=str(data_yaml),
            epochs=args.epochs,
            imgsz=args.imgsz,
            batch=args.batch,
            workers=args.workers,
            device="cpu",
            project=str(ROOT / "runs"),
            name=RUN_NAME,
            patience=15,
            exist_ok=True,
        )

    best = ROOT / "runs" / RUN_NAME / "weights" / "best.pt"
    onnx_path = YOLO(str(best)).export(format="onnx", imgsz=args.imgsz)
    print(f"학습 완료. best: {best}\nONNX: {onnx_path}")


if __name__ == "__main__":
    main()
