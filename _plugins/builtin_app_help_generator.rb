# Generates help pages to be loaded into application’s built-in Help window.
# Generates pages from docs collection, but sets an extra frontmatter variable
# ``in_app_help: true`` for each page.
#
# Note: “docs” below can be used to refer to documentation pages
# as well as to Jekyll’s concept of “document”.

module Jekyll
  class InAppHelpPage < Page
    def initialize(site, base_dir, url_prefix, path, content, data)
      @site = site
      @base = base_dir

      url_prefix = site.config['in_app_help']['url_prefix']

      if path == '/index'
        @dir = url_prefix
      else
        @dir = File.join(url_prefix, path)
      end

      @content = content

      @name = "index.html"

      self.process(@name)

      self.data = data.clone
      self.data['in_app_help'] = true
      self.data['permalink'] = nil
      self.data['site_title'] = "#{site.config['in_app_help']['app_name']} Help"
    end
  end

  class Site
    def write_in_app_help_pages(in_collection, url_prefix)
      originals = @collections[in_collection]
      originals.docs.each do |doc|
        if doc.data['permalink']
          permalink = doc.data['permalink'].sub("/#{in_collection}/", '')
        else
          permalink = doc.cleaned_relative_path
        end
        page = InAppHelpPage.new(self, self.source, url_prefix, permalink, doc.content, doc.data)
        @pages << page
      end
    end
  end
end


Jekyll::Hooks.register :site, :post_read do |site|
  if site.config.key?('in_app_help')
    cfg = site.config['in_app_help']
    site.write_in_app_help_pages(
      cfg['in_collection'],
      cfg['url_prefix'])
  end
end
