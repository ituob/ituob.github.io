.PHONY: _site
SHELL := /bin/bash

all: _site

Gemfile.lock:
	bundle install

clean:
	bundle exec jekyll clean
	rm -rf _site

_site: Gemfile.lock
	bundle exec jekyll build --trace

serve:
	bundle exec jekyll serve --trace

update-init:
	git submodule update --init

update-modules:
	git submodule foreach git pull origin main

.PHONY: all clean serve update-init update-modules
