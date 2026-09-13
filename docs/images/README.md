# README images

Regenerate with headless Chrome (no other tooling needed). `port-rule.html` is the source of the
decode plate; the dashboard images come from a running `berth ui` on port 10000.

```bash
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cd docs/images
for t in dark light; do
  "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1252,486 --virtual-time-budget=6000 \
    --screenshot="$PWD/port-rule-$t.png" "file://$PWD/port-rule.html?theme=$t"
done
for spec in map:dark map:light table:dark; do v=${spec%%:*}; t=${spec##*:}
  "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1440,860 --virtual-time-budget=8000 \
    --screenshot="$PWD/dashboard-$v-$t.png" "http://127.0.0.1:10000/?view=$v&theme=$t"
done
```
