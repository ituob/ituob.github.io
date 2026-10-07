# frozen_string_literal: true
# dataset_page_generator.rb
#
# New-pipeline dataset page generator. Emits:
#   /datasets/{name}/index.html          — current snapshot
#   /datasets/{name}/history/index.html  — chronological change log
#   /datasets/{name}/issue/{id}/index.html — changes a specific issue made
#
# Only active when site.config['rendering_pipeline'] == 'new'.

module Jekyll
  class DatasetPage < Page
    def initialize(site, slug, metadata, layout = 'dataset')
      @site = site
      @base = site.source
      @dir = File.join('datasets', slug)
      @name = 'index.html'
      self.process(@name)
      self.data = {
        'layout' => layout,
        'dataset_slug' => slug,
        'dataset_metadata' => metadata,
      }
    end
  end

  class DatasetHistoryPage < Page
    def initialize(site, slug, metadata)
      @site = site
      @base = site.source
      @dir = File.join('datasets', slug, 'history')
      @name = 'index.html'
      self.process(@name)
      self.data = {
        'layout' => 'dataset_history',
        'dataset_slug' => slug,
        'dataset_metadata' => metadata,
      }
    end
  end

  class DatasetIssuePage < Page
    def initialize(site, slug, issue_id, changes)
      @site = site
      @base = site.source
      @dir = File.join('datasets', slug, 'issue', issue_id.to_s)
      @name = 'index.html'
      self.process(@name)
      self.data = {
        'layout' => 'dataset_issue',
        'dataset_slug' => slug,
        'issue_id' => issue_id,
        'changes' => changes,
      }
    end
  end

  class Site
    def write_dataset_pages
      return unless config['rendering_pipeline'] == 'new'
      datasets = (data['ob'] || {})['datasets'] || {}
      datasets.each do |slug, ds|
        meta = ds['metadata'] || {}
        pages << DatasetPage.new(self, slug, meta)
        pages << DatasetHistoryPage.new(self, slug, meta)
      end
    end
  end

  class DatasetPageGenerator < Generator
    safe true
    priority :low

    def generate(site)
      site.write_dataset_pages
    end
  end
end
