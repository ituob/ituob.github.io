SHELL := /bin/bash

all: _site

clean:
	rm -rf _site

_site:
	bundle exec jekyll build --trace

serve:
	bundle exec jekyll serve --trace

update-init:
	git submodule update --init

update-modules:
	git submodule foreach git pull origin master

.PHONY: all clean serve update-init update-modules
