#!/usr/bin/env python3
"""안전그네 2단계 분류기용 사람 크롭 데이터셋 생성.

안전그네는 공개 데이터셋이 전부 65~445장 수준으로 작아 YOLO 탐지 클래스로는
부적합 → 사람 영역을 크롭해 "착용/미착용" 이진 분류기로 학습한다
(training/train_clothing_classifier.py와 같은 접근, 별도 모델로 분리).

라벨 규칙:
- harness2(body+harness 박스 둘 다 있음): body 박스 크롭, 그 안에 harness 박스가
  많이 겹치면 착용(1), 안 겹치면 미착용(0)
- harness1, harness3(harness 박스만 있음, body 없음): harness 박스를 넉넉히
  확장(패딩)해서 사람 상반신 근사 영역으로 크롭 → 착용(1)
- 미착용(0) 네거티브 보강: HB1204/PPE_Detection의 Person 박스 크롭
  (이 데이터셋엔 안전그네 클래스가 아예 없어 대부분 미착용으로 간주 가능)

출력: training/harness_crops/{train,val,test}/{0,1}/*.jpg (ImageFolder 포맷)
"""
from __future__ import annotations

import random
from pathlib import Path

from PIL import Image

RAW = Path(__file__).parent / "raw_datasets"
OUT = Path(__file__).parent / "harness_crops"
SEED = 42
PAD_RATIO = 1.8  # harness 박스만 있을 때 상하좌우로 확장할 배율


def _read_yolo_labels(lbl_path: Path) -> list[tuple[int, float, float, float, float]]:
    if not lbl_path.exists():
        return []
    out = []
    for line in lbl_path.read_text().splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        cls = int(parts[0])
        cx, cy, w, h = map(float, parts[1:5])
        out.append((cls, cx, cy, w, h))
    return out


def _yolo_to_xyxy(cx, cy, w, h, img_w, img_h):
    x0 = (cx - w / 2) * img_w
    y0 = (cy - h / 2) * img_h
    x1 = (cx + w / 2) * img_w
    y1 = (cy + h / 2) * img_h
    return x0, y0, x1, y1


def _iou_contain(a, b) -> float:
    """b가 a 안에 얼마나 겹치는지 비율(b 면적 기준)."""
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    b_area = max(1e-6, (bx1 - bx0) * (by1 - by0))
    return inter / b_area


_counter = {"0": 0, "1": 0}


def _save_crop(img: Image.Image, box, label: int, split: str, prefix: str):
    x0, y0, x1, y1 = box
    x0, y0 = max(0, int(x0)), max(0, int(y0))
    x1, y1 = min(img.width, int(x1)), min(img.height, int(y1))
    if x1 - x0 < 20 or y1 - y0 < 20:
        return
    crop = img.crop((x0, y0, x1, y1))
    _counter[str(label)] += 1
    out_dir = OUT / split / str(label)
    out_dir.mkdir(parents=True, exist_ok=True)
    crop.convert("RGB").save(out_dir / f"{prefix}_{_counter[str(label)]}.jpg", quality=90)


def _split_for(rng: random.Random) -> str:
    r = rng.random()
    if r < 0.8:
        return "train"
    if r < 0.9:
        return "val"
    return "test"


def process_harness2():
    """body + harness 박스 둘 다 있음 — 겹침으로 착용/미착용 판정."""
    rng = random.Random(SEED)
    base = RAW / "harness2"
    for split_dir in ("train", "valid", "test"):
        img_dir = base / split_dir / "images"
        lbl_dir = base / split_dir / "labels"
        if not img_dir.exists():
            continue
        for img_path in sorted(img_dir.iterdir()):
            if img_path.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                continue
            labels = _read_yolo_labels(lbl_dir / f"{img_path.stem}.txt")
            if not labels:
                continue
            try:
                img = Image.open(img_path)
            except Exception:
                continue
            bodies = [l for l in labels if l[0] == 0]
            harnesses = [l for l in labels if l[0] == 1]
            harness_boxes = [_yolo_to_xyxy(*h[1:], img.width, img.height) for h in harnesses]
            for b in bodies:
                body_box = _yolo_to_xyxy(*b[1:], img.width, img.height)
                worn = any(_iou_contain(body_box, hb) > 0.5 for hb in harness_boxes)
                _save_crop(img, body_box, 1 if worn else 0, _split_for(rng), "h2")


def process_harness_boxonly(dataset_name: str, prefix: str):
    """harness 박스만 있음(body 없음) — 패딩해서 상반신 근사 → 착용(1)."""
    rng = random.Random(SEED)
    base = RAW / dataset_name
    for split_dir in ("train", "valid", "test"):
        img_dir = base / split_dir / "images"
        lbl_dir = base / split_dir / "labels"
        if not img_dir.exists():
            continue
        for img_path in sorted(img_dir.iterdir()):
            if img_path.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                continue
            labels = _read_yolo_labels(lbl_dir / f"{img_path.stem}.txt")
            if not labels:
                continue
            try:
                img = Image.open(img_path)
            except Exception:
                continue
            for l in labels:
                x0, y0, x1, y1 = _yolo_to_xyxy(*l[1:], img.width, img.height)
                w, h = x1 - x0, y1 - y0
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                pw, ph = w * PAD_RATIO, h * PAD_RATIO
                box = (cx - pw / 2, cy - ph / 2, cx + pw / 2, cy + ph / 2)
                _save_crop(img, box, 1, _split_for(rng), prefix)


def process_negatives_from_ppe(max_count: int = 600):
    """HB1204/PPE_Detection의 Person 박스 → 미착용(0) 네거티브."""
    rng = random.Random(SEED)
    base = RAW / "PPE_Detection"
    added = 0
    split_dirs = {"train": "train", "valid": "valid", "test": "test"}
    all_candidates = []
    for split_dir in split_dirs.values():
        img_dir = base / split_dir / "images"
        lbl_dir = base / split_dir / "labels"
        if not img_dir.exists():
            continue
        for img_path in sorted(img_dir.iterdir()):
            if img_path.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                continue
            labels = _read_yolo_labels(lbl_dir / f"{img_path.stem}.txt")
            persons = [l for l in labels if l[0] == 9]  # Person
            if persons:
                all_candidates.append((img_path, persons))
    rng.shuffle(all_candidates)
    for img_path, persons in all_candidates:
        if added >= max_count:
            break
        try:
            img = Image.open(img_path)
        except Exception:
            continue
        for p in persons[:1]:  # 이미지당 1개만 (다양성 확보)
            box = _yolo_to_xyxy(*p[1:], img.width, img.height)
            _save_crop(img, box, 0, _split_for(rng), "neg")
            added += 1


if __name__ == "__main__":
    if OUT.exists():
        import shutil
        shutil.rmtree(OUT)
    process_harness2()
    process_harness_boxonly("harness1", "h1")
    process_harness_boxonly("harness3", "h3")
    process_negatives_from_ppe(max_count=600)

    for split in ("train", "val", "test"):
        for label in ("0", "1"):
            n = len(list((OUT / split / label).glob("*.jpg"))) if (OUT / split / label).exists() else 0
            print(f"{split}/{label}: {n}장")
    print("완료:", OUT)
