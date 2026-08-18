#!/usr/bin/env python3
"""
YOLOv8 Nano를 ONNX로 변환
4개 클래스: no_helmet, no_vest, fire_smoke, man_down
"""

from ultralytics import YOLO
import os

# YOLOv8 Nano 다운로드 및 로드
print("YOLOv8 Nano 모델 로드 중...")
model = YOLO("yolov8n.pt")

# ONNX로 변환
print("ONNX로 변환 중...")
output_path = model.export(
    format="onnx",
    imgsz=640,
)

print(f"✅ 모델 생성 완료!")
print(f"📁 위치: {output_path}")

# public/models로 복사
import shutil
dest = "./public/models/detector.onnx"
shutil.copy(output_path, dest)
print(f"✅ 배포 위치로 복사: {dest}")
