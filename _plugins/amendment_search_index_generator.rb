module Jekyll

  class Site
    AMENDMENT_TYPES = ['ships_maritime', 'iptn', 'mnc']
    AMENDMENT_INDEXES_ROOT = File.join("data", "amendment_indexes")

    def write_amendment_search_indexes
      FileUtils.mkdir_p(File.join(self.source, AMENDMENT_INDEXES_ROOT))

      AMENDMENT_TYPES.each do |type|
        self.write_amendment_index_for_type(type)
      end
    end

    def write_amendment_index_for_type(amendment_type)
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
      index_file_path = File.join(
        self.source,
        AMENDMENT_INDEXES_ROOT,
        index_filename)

      File.open(index_file_path, "w") do |f|
        f.write(JSON.pretty_generate(index))
      end

      self.static_files << Jekyll::StaticFile.new(
        self,
        self.source,
        AMENDMENT_INDEXES_ROOT,
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
