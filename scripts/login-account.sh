#!/usr/bin/env bash
# login-account.sh — Helper script to log in to one of your 4 ChatGPT accounts on your desktop GUI.
#
# Usage:
#   ./login-account.sh 1    # Login to Account 1
#   ./login-account.sh 2    # Login to Account 2
#   ./login-account.sh 3    # Login to Account 3
#   ./login-account.sh 4    # Login to Account 4

set -e

ACCOUNT="${1:-1}"

case "$ACCOUNT" in
  1)
    DATA_DIR="/home/long/.config/google-chrome-chatgpt"
    PORT=9021
    ;;
  2)
    DATA_DIR="/home/long/.config/google-chrome-chatgpt-2"
    PORT=9022
    ;;
  3)
    DATA_DIR="/home/long/.config/google-chrome-chatgpt-3"
    PORT=9023
    ;;
  4)
    DATA_DIR="/home/long/.config/google-chrome-chatgpt-4"
    PORT=9024
    ;;
  *)
    echo "❌ Lỗi: Chỉ hỗ trợ tài khoản số 1, 2, 3, hoặc 4."
    echo "Cách dùng: ./login-account.sh <1|2|3|4>"
    exit 1
    ;;
esac

mkdir -p "$DATA_DIR"

echo "=========================================================="
echo "🚀 ĐANG MỞ GOOGLE CHROME CHO TÀI KHOẢN $ACCOUNT..."
echo "📂 Profile directory: $DATA_DIR"
echo "🌐 Đích đến: https://chatgpt.com/"
echo "=========================================================="
echo "👉 HƯỚNG DẪN DÀNH CHO BOSS:"
echo "1. Cửa sổ Chrome sẽ xuất hiện trên màn hình desktop chính."
echo "2. Hãy đăng nhập tài khoản ChatGPT tương ứng (Email/Google/Apple)."
echo "3. Tích chọn 'Keep me logged in' (Duy trì đăng nhập)."
echo "4. Sau khi vào được giao diện chính của ChatGPT, hãy ĐÓNG cửa sổ Chrome lại."
echo "   (Thông tin đăng nhập và Cookies sẽ được lưu vĩnh viễn trong thư mục profile)."
echo "=========================================================="

# Launch Chrome on the active desktop display
if [ -n "$DISPLAY" ]; then
  google-chrome --user-data-dir="$DATA_DIR" "https://chatgpt.com/"
else
  DISPLAY=":0" google-chrome --user-data-dir="$DATA_DIR" "https://chatgpt.com/"
fi

echo "✅ Đã lưu profile thành công cho Tài khoản $ACCOUNT!"
