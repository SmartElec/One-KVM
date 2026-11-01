#!/bin/bash
# 在构建机（6.12）上打定制版 deb
# 与直接跑 build/package-deb.sh 的区别：在包里注入 /usr/share/one-kvm/build-info.txt
# （版本、分支、提交、构建时间），设备上的部署档案可以直接读到，出问题能追到具体提交。
#
# 用法: ./tools/package-custom-deb.sh [版本号]
#   不给版本号时自动生成：<Cargo 版本>+custom<月日时分>
set -euo pipefail

ROOT="${ONE_KVM_ROOT:-/root/One-KVM}"
cd "$ROOT"

CARGO_VERSION=$(grep -m1 '^version =' Cargo.toml | cut -d'"' -f2)
VERSION="${1:-${CARGO_VERSION}+custom$(date +%m%d%H%M)}"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMIT=$(git rev-parse --short HEAD)
COMMIT_FULL=$(git rev-parse HEAD)
DIRTY=$(if [ -z "$(git status --porcelain)" ]; then echo no; else echo yes; fi)

echo "打包 $VERSION（$BRANCH @ $COMMIT dirty=$DIRTY）"
bash build/package-deb.sh arm64 > /tmp/package-custom-deb.log 2>&1 || {
    echo "ERROR: build/package-deb.sh 失败，见 /tmp/package-custom-deb.log"
    tail -5 /tmp/package-custom-deb.log
    exit 1
}

SOURCE_DEB="target/debian/one-kvm_${CARGO_VERSION}_arm64.deb"
OUT_DEB="target/debian/one-kvm_${VERSION}_arm64.deb"
[ -f "$SOURCE_DEB" ] || { echo "ERROR: 没找到 $SOURCE_DEB"; exit 1; }

WORK=/tmp/one-kvm-deb-work
rm -rf "$WORK"
dpkg-deb -R "$SOURCE_DEB" "$WORK"

# 内置 systemd drop-in：静态画面跳过。
# 这是"装了就对"的关键——之前靠部署脚本手工建，全新镜像会漏，
# 表现为画面静止时帧率显示不再跳动。
mkdir -p "$WORK/etc/systemd/system/one-kvm.service.d"
cat > "$WORK/etc/systemd/system/one-kvm.service.d/skip-static.conf" <<'CONF'
[Service]
Environment=ONE_KVM_SKIP_STATIC=1
Environment=ONE_KVM_SKIP_ROWS=4
CONF

# postinst 补 daemon-reload，否则新装进的 drop-in 不会生效
sed -i 's|^            systemctl enable one-kvm$|            systemctl daemon-reload\n            systemctl enable one-kvm|' "$WORK/DEBIAN/postinst"
if ! grep -q 'daemon-reload' "$WORK/DEBIAN/postinst"; then
    echo "ERROR: postinst 里没插入 daemon-reload（上游脚本可能变了）"
    exit 1
fi

mkdir -p "$WORK/usr/share/one-kvm"
cat > "$WORK/usr/share/one-kvm/build-info.txt" <<EOF
version: ${VERSION}
branch: ${BRANCH}
commit: ${COMMIT}
commit_full: ${COMMIT_FULL}
dirty: ${DIRTY}
built_at: $(date -Iseconds)
built_on: $(hostname)
EOF

sed -i "s/^Version: .*/Version: ${VERSION}/" "$WORK/DEBIAN/control"
rm -f "$OUT_DEB"
dpkg-deb --build "$WORK" "$OUT_DEB" > /dev/null
rm -rf "$WORK"

echo "产出: $OUT_DEB"
dpkg-deb -f "$OUT_DEB" Package Version Architecture
sha256sum "$OUT_DEB"
