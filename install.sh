#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer with sudo: sudo ./install.sh" >&2
  exit 1
fi

APP_DIR=/opt/travel-empire-dialer
DATA_DIR=/var/lib/travel-empire-dialer
SECRETS_DIR=/etc/travel-empire
NGINX_SITE=/etc/nginx/sites-available/dialer.travelempire.org
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for required in docker nginx asterisk openssl; do
  command -v "$required" >/dev/null || { echo "Missing required command: $required" >&2; exit 1; }
done

test -f "$SECRETS_DIR/advisor-credentials" || { echo "Missing $SECRETS_DIR/advisor-credentials" >&2; exit 1; }
test -f /etc/letsencrypt/live/dialer.travelempire.org/fullchain.pem || { echo "Missing HTTPS certificate" >&2; exit 1; }

mkdir -p "$APP_DIR" "$DATA_DIR" "$SECRETS_DIR"
if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
  cp -a "$SOURCE_DIR/." "$APP_DIR/"
fi
chmod 700 "$DATA_DIR" "$SECRETS_DIR"

if [[ ! -f "$SECRETS_DIR/app-session-secret" ]]; then
  openssl rand -hex 48 > "$SECRETS_DIR/app-session-secret"
fi
if [[ ! -f "$SECRETS_DIR/crm-sso-secret" ]]; then
  openssl rand -hex 48 > "$SECRETS_DIR/crm-sso-secret"
fi
if [[ ! -f "$SECRETS_DIR/voicemail-pin" ]]; then
  printf '%04d\n' "$((1000 + RANDOM % 9000))" > "$SECRETS_DIR/voicemail-pin"
fi

if [[ ! -f "$SECRETS_DIR/ami-credentials" ]]; then
  ami_password="$(openssl rand -hex 32)"
  cat > "$SECRETS_DIR/ami-credentials" <<EOF
AMI_USERNAME=tedialer
AMI_PASSWORD=$ami_password
EOF
fi
chmod 600 "$SECRETS_DIR/app-session-secret" "$SECRETS_DIR/crm-sso-secret" "$SECRETS_DIR/voicemail-pin" "$SECRETS_DIR/ami-credentials"

ami_password="$(awk -F= '$1=="AMI_PASSWORD"{print substr($0,index($0,"=")+1)}' "$SECRETS_DIR/ami-credentials")"
cat > /etc/asterisk/manager_travel_empire.conf <<EOF
[general]
enabled=yes
webenabled=no
port=5038
bindaddr=127.0.0.1

[tedialer]
secret=$ami_password
deny=0.0.0.0/0.0.0.0
permit=127.0.0.1/255.255.255.255
read=system,call,agent,user,reporting
write=system,call,agent,user,reporting
EOF
chown root:asterisk /etc/asterisk/manager_travel_empire.conf
chmod 640 /etc/asterisk/manager_travel_empire.conf
grep -qF '#include "manager_travel_empire.conf"' /etc/asterisk/manager.conf || echo '#include "manager_travel_empire.conf"' >> /etc/asterisk/manager.conf

install_asterisk_include() {
  local parent="$1" include_file="$2"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  cp -a "/etc/asterisk/$parent" "/etc/asterisk/$parent.before-travel-empire-$stamp"
  install -o root -g asterisk -m 640 "$SOURCE_DIR/asterisk/config/$include_file" "/etc/asterisk/$include_file"
  if ! grep -qF "#include \"$include_file\"" "/etc/asterisk/$parent"; then
    printf '\n#include "%s"\n' "$include_file" >> "/etc/asterisk/$parent"
  fi
}

install_asterisk_include extensions.conf extensions_travel_empire_ivr.conf
install_asterisk_include queues.conf queues_travel_empire.conf
install_asterisk_include musiconhold.conf musiconhold_travel_empire.conf
install_asterisk_include voicemail.conf voicemail_travel_empire.conf
voicemail_pin="$(tr -dc '0-9' < "$SECRETS_DIR/voicemail-pin" | head -c 4)"
[[ ${#voicemail_pin} -eq 4 ]] || { echo "Invalid private voicemail PIN" >&2; exit 1; }
sed -i "s/__VM_PIN__/$voicemail_pin/g" /etc/asterisk/voicemail_travel_empire.conf

install -d -o asterisk -g asterisk -m 755 /var/lib/asterisk/sounds/custom/travel-empire /var/lib/asterisk/moh/travel-empire
install -o asterisk -g asterisk -m 644 "$SOURCE_DIR"/asterisk/audio/*.wav /var/lib/asterisk/sounds/custom/travel-empire/
install -o asterisk -g asterisk -m 644 "$SOURCE_DIR/asterisk/audio/te-hold-music.wav" /var/lib/asterisk/moh/travel-empire/te-hold-music.wav

cat > /etc/asterisk/rtp.conf <<'EOF'
[general]
rtpstart=10000
rtpend=10199
strictrtp=yes
icesupport=yes
EOF
ufw allow 10000:10199/udp comment 'Asterisk browser and carrier media' >/dev/null

cp "$NGINX_SITE" "${NGINX_SITE}.before-dialer-app"
cat > "$NGINX_SITE" <<'EOF'
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name dialer.travelempire.org;

    ssl_certificate /etc/letsencrypt/live/dialer.travelempire.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dialer.travelempire.org/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location /ws {
        proxy_pass http://127.0.0.1:8088/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name dialer.travelempire.org;
    return 301 https://$host$request_uri;
}
EOF

nginx -t
systemctl reload nginx
systemctl restart asterisk

cd "$APP_DIR"
docker compose up -d --build

for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:3000/health >/dev/null; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:3000/health >/dev/null || { docker compose logs --tail=100; exit 1; }

echo
echo "Travel Empire Dialer installed successfully."
echo "Open: https://dialer.travelempire.org"
echo "Advisor access is CRM-only through the WordPress SSO connector."
echo "Install wordpress-plugin/travel-empire-dialer-sso.php on the CRM and configure its private shared secret."
echo "Private voicemail PIN: $SECRETS_DIR/voicemail-pin (root-readable only)"
