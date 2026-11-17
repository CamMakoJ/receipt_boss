#!/usr/bin/env bash
# Make a private CA + a server certificate for your LAN name/IP, for TLS_CERT / TLS_KEY.
#   scripts/make-cert.sh receipts.home.lan 192.168.1.50
# Then install data/tls/ca.pem on each phone/computer (so the browser trusts it).
# Prefer `tailscale cert` if you use a *.ts.net name (see README) -- no CA to install.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 <hostname-or-ip> [more names/IPs...]"; exit 1; }
OUT="${TLS_DIR:-data/tls}"
mkdir -p "$OUT"; cd "$OUT"

if [ ! -f ca.key ]; then
  openssl req -x509 -newkey rsa:4096 -nodes -keyout ca.key -out ca.pem -days 3650 \
    -subj "/CN=Receipt Boss local CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  chmod 600 ca.key
fi

SAN=""
for n in "$@"; do
  if [[ "$n" =~ ^[0-9.]+$ || "$n" == *:* ]]; then SAN+="IP:$n,"; else SAN+="DNS:$n,"; fi
done
SAN="${SAN%,}"

openssl req -newkey rsa:2048 -nodes -keyout key.pem -out server.csr -subj "/CN=$1" 2>/dev/null
printf "subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" "$SAN" > ext.cnf
# 397 days is the max most browsers/Apple accept for server certs
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out cert.pem -days 397 -extfile ext.cnf 2>/dev/null
rm -f server.csr ext.cnf; chmod 600 key.pem
echo "Created in $PWD:"
echo "  cert.pem + key.pem   -> TLS_CERT=$PWD/cert.pem TLS_KEY=$PWD/key.pem"
echo "  ca.pem               -> install/trust this on your phone & computers"
echo "Valid for: $SAN   (re-run before it expires in ~13 months)"
