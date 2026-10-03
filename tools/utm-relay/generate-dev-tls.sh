#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <utm-hostname-or-ip>" >&2
  exit 2
fi

HOST="$1"
OUT_DIR="\${BKE_UTM_RELAY_TLS_DIR:-.bke-worker-utm-relay/tls}"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

CA_KEY="$OUT_DIR/bke-worker-dev-ca.key"
CA_CERT="$OUT_DIR/bke-worker-dev-ca.crt"
SERVER_KEY="$OUT_DIR/server.key"
SERVER_CSR="$OUT_DIR/server.csr"
SERVER_CERT="$OUT_DIR/server.crt"
EXT="$OUT_DIR/server.ext"

if [[ ! -f "$CA_KEY" || ! -f "$CA_CERT" ]]; then
  openssl genrsa -out "$CA_KEY" 3072
  chmod 600 "$CA_KEY"
  openssl req -x509 -new -nodes \
    -key "$CA_KEY" \
    -sha256 \
    -days 30 \
    -subj "/CN=BKE Worker UTM Dev CA" \
    -out "$CA_CERT"
fi

openssl genrsa -out "$SERVER_KEY" 2048
chmod 600 "$SERVER_KEY"

openssl req -new \
  -key "$SERVER_KEY" \
  -subj "/CN=$HOST" \
  -out "$SERVER_CSR"

if [[ "$HOST" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  SAN="IP:$HOST,IP:127.0.0.1,DNS:localhost"
else
  SAN="DNS:$HOST,DNS:localhost,IP:127.0.0.1"
fi

cat > "$EXT" <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
EOF

openssl x509 -req \
  -in "$SERVER_CSR" \
  -CA "$CA_CERT" \
  -CAkey "$CA_KEY" \
  -CAcreateserial \
  -out "$SERVER_CERT" \
  -days 14 \
  -sha256 \
  -extfile "$EXT"

rm -f "$SERVER_CSR" "$EXT"

echo "Generated:"
echo "  CA cert:     $CA_CERT"
echo "  Server cert: $SERVER_CERT"
echo "  Server key:  $SERVER_KEY"
echo
echo "Install ONLY the CA cert on the Android emulator as a user CA."
echo "Never copy the CA private key or server private key to Android."
