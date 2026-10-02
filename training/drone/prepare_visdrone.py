#!/usr/bin/env python3
"""VisDrone2019-DET → 드론(항공 시점) 탐지기용 YOLO 학습셋 변환.

출처: VisDrone2019-DET train/val (Ultralytics GitHub release 미러에서 받음,
training/raw_datasets/visdrone/). 비상업 연구용 라이선스 — 사내 사용 승인 확인됨(2026-10-02).

VisDrone 원본 카테고리 → 우리 클래스:
  1 pedestrian, 2 people → 0 person
  4 car, 5 van           → 1 car
  6 truck                → 2 truck
  9 bus                  → 3 bus
  10 motor               → 4 motorcycle
  0 ignored region, 3 bicycle, 7 tricycle, 8 awning-tricycle, 11 others → 제외
score=0인 박스는 VisDrone 규약상 "무시 영역"이라 제외한다.

최종 클래스 순서는 앱(drone 탐지기 후처리)과 반드시 일치해야 한다: AERIAL_CLASSES
"""
from __future__ import annotations

import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).parent
RAW = ROOT.parent / "raw_datasets" / "visdrone"
OUT = ROOT / "visdrone_yolo"

AERIAL_CLASSES = ["person", "car", "truck", "bus", "motorcycle"]
CATEGORY_MAP = {1: 0, 2: 0, 4: 1, 5: 1, 6: 2, 9: 3, 10: 4}

SPLITS = {"train": "VisDrone2019-DET-train", "val": "VisDrone2019-DET-val"}


def convert_split(split: str, src_name: str) -> tuple[int, int]:
    src = RAW / src_name
    img_out = OUT / "images" / split
    lbl_out = OUT / "labels" / split
    img_out.mkdir(parents=True, exist_ok=True)
    lbl_out.mkdir(parents=True, exist_ok=True)

    n_images = n_boxes = 0
    for ann_path in sorted((src / "annotations").glob("*.txt")):
        img_path = src / "images" / f"{ann_path.stem}.jpg"
        if not img_path.exists():
            continue
        with Image.open(img_path) as im:
            w, h = im.size

        lines = []
        for row in ann_path.read_text().strip().splitlines():
            parts = row.strip().rstrip(",").split(",")
            if len(parts) < 6:
                continue
            x, y, bw, bh, score, cat = (int(v) for v in parts[:6])
            if score == 0 or cat not in CATEGORY_MAP or bw <= 0 or bh <= 0:
                continue
            cx = (x + bw / 2) / w
            cy = (y + bh / 2) / h
            lines.append(f"{CATEGORY_MAP[cat]} {cx:.6f} {cy:.6f} {bw / w:.6f} {bh / h:.6f}")

        shutil.copy2(img_path, img_out / img_path.name)
        (lbl_out / f"{ann_path.stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))
        n_images += 1
        n_boxes += len(lines)
    return n_images, n_boxes


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    for split, src_name in SPLITS.items():
        n_img, n_box = convert_split(split, src_name)
        print(f"{split}: 이미지 {n_img}장, 박스 {n_box}개")

    names = "\n".join(f"  {i}: {n}" for i, n in enumerate(AERIAL_CLASSES))
    (OUT / "data.yaml").write_text(
        f"path: {OUT}\ntrain: images/train\nval: images/val\nnames:\n{names}\n"
    )
    print(f"완료: {OUT / 'data.yaml'}")


if __name__ == "__main__":
    main()
