import os
import re
import base64
import logging

import cv2
import numpy as np
import pytesseract
from flask import Flask, request, jsonify, render_template

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)


def preprocess_image(image_bytes: bytes) -> np.ndarray:
    """
    Pre-process a cracked, glowing blue LCD screen image for OCR.
    Steps:
      1. Decode JPEG/PNG bytes → BGR array
      2. Resize to 500 px wide (preserve aspect ratio)
      3. Convert to HSV and extract Value channel (brightness, hue-agnostic)
      4. Gaussian blur to kill LED bloom/glow artifacts
      5. Otsu threshold → clean binary image
      6. Morphological close to fill gaps in digit strokes
    """
    np_arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")

    # 1. Resize to 500 px wide, preserve aspect ratio
    h, w = img.shape[:2]
    scale = 500 / w
    new_h = int(h * scale)
    img = cv2.resize(img, (500, new_h), interpolation=cv2.INTER_AREA)

    # 2. Use HSV Value channel — works for blue, red, green LCDs alike
    #    (Red channel was wrong for a blue LCD and caused phantom detections)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    v_channel = hsv[:, :, 2]

    # 3. Gaussian blur before thresholding to suppress bloom/glow noise
    blurred = cv2.GaussianBlur(v_channel, (5, 5), 0)

    # 4. Otsu threshold on denoised brightness
    _, binary = cv2.threshold(
        blurred, 0, 255,
        cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )

    # 5. Morphological close to fill small gaps inside digit strokes
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

    logger.debug("Preprocessed image shape: %s", binary.shape)
    return binary


def run_ocr(binary_image: np.ndarray) -> str:
    """
    Run Tesseract with a digit-only whitelist.
    Tries PSM 7 (single text line) first, then PSM 8 (single word) as fallback.
    Returns the cleaned digit string or empty string.
    """
    for psm in (7, 8):
        config = f"--psm {psm} -c tessedit_char_whitelist=0123456789"
        raw = pytesseract.image_to_string(binary_image, config=config)
        cleaned = re.sub(r"\D", "", raw).strip()
        if cleaned:
            logger.info("OCR result with PSM %d: '%s'", psm, cleaned)
            return cleaned

    logger.info("OCR found no digits")
    return ""


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/scan", methods=["POST"])
def scan():
    """
    Accepts a JSON body:  { "image": "<base64-encoded JPEG>" }
    Returns:              { "floor": "12" }  or  { "floor": "" }
    """
    try:
        data = request.get_json(force=True, silent=True) or {}
        b64 = data.get("image", "")

        if not b64:
            return jsonify({"error": "No image provided", "floor": ""}), 400

        # Strip data-URL prefix if present  (e.g. "data:image/jpeg;base64,...")
        if "," in b64:
            b64 = b64.split(",", 1)[1]

        image_bytes = base64.b64decode(b64)
        binary = preprocess_image(image_bytes)
        floor = run_ocr(binary)

        logger.info("Final floor result: '%s'", floor)
        return jsonify({"floor": floor})

    except Exception as exc:
        logger.exception("Scan failed: %s", exc)
        return jsonify({"error": str(exc), "floor": ""}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)