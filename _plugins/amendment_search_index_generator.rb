module Jekyll

  class Site
    def write_amendment_search_indexes
      indexes_root = File.join("data", "amendments")
      FileUtils.mkdir_p(File.join(self.source, indexes_root))

      ['ships_maritime', 'iptn', 'mnc'].each do |type|
        self.write_amendment_index_for_type(type, indexes_root)
      end
    end

    def write_amendment_index_for_type(amendment_type, indexes_root)
      amendments = []

      self.data['issues'].each do |issue|
        if issue['amendments'][amendment_type]
          issue['amendments'][amendment_type].each do |change|
            amendments.push change
          end
        end
      end

      index = { 'items' => amendments }
      index_filename = "#{amendment_type}.json"

      File.open(File.join(self.source, indexes_root, index_filename), "w") do |f|
        f.write(JSON.pretty_generate(index))
      end

      self.static_files << Jekyll::StaticFile.new(
        self,
        self.source,
        indexes_root,
        index_filename)
    end
  end


  class AmendmentSearchIndexGenerator < Generator
    safe true
    priority :low

    def generate(site)
      site.write_amendment_search_indexes
    end
  end

end
