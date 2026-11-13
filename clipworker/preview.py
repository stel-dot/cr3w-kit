# Make a one-off preview Short from the server console (no colons or quotes needed):
#   docker exec cr3w-clipworker-1 python preview.py <name> <clip link without https> <hook words...>
# The result plays at https://city.cr3winc.com/clips/<name>.mp4
import json, sys
import app

name, link, hook = sys.argv[1], sys.argv[2], ' '.join(sys.argv[3:])
url = link if '://' in link else 'https://' + link
print(json.dumps(app.render_short({'id': name, 'url': url, 'hook': hook or None, 'streamer': '', 'clean': True}), indent=1))
