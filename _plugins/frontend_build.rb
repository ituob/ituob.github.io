# This plugin calls the Node-based Babel to process select assets,
# using the source “assets” directory as input and _site/assets as output.
#
# As of now, it only processes the JavaScript.
#
# TODO:
# - Post-process the CSS with auto-prefixer and other 
# - Combine front-end assets into a few packages (bulk of JS, bulk of CSS) and minify it
# - Split this into a standalone Jekyll plugin
# - (?) Use Web components, e.g. Polymer

Jekyll::Hooks.register :site, :post_write do |site|
  run_frontend_build()
end

def run_frontend_build()
  system('./node_modules/.bin/babel assets/js --out-dir _site/assets/js')
end
