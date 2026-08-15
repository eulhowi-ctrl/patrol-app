# 모델 파일 배치 위치

이 폴더에 학습된 객체 감지 모델을 `detector.onnx` 이름으로 넣는다.

- 클래스 구성은 `web/src/lib/labels.ts`의 `DETECTION_LABELS`와 반드시 일치해야 한다.
  (보호구 미착용, 위험지역 진입, 화재/불꽃, 쓰러짐 4개 카테고리)
- YOLOv8/v10 Nano를 위 4개 클래스로 파인튜닝 후 INT8/FP16 양자화하여 `.onnx`로 export한다.
- 이 저장소는 모델 가중치 파일 자체를 포함하지 않는다 (용량 및 라이선스 문제).
  `web/src/workers/detection.worker.ts`는 이 경로(`NEXT_PUBLIC_MODEL_PATH`)에서 모델을 로드하도록 작성되어 있다.
