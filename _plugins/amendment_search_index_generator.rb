module Jekyll

  class Site

    OB_AMENDMENT_TYPES = ['ships_maritime', 'iptn', 'mnc']
    AMENDMENT_INDEXES_ROOT = File.join("data", "amendment_indexes")

    def write_amendment_search_indexes
      FileUtils.mkdir_p(File.join(self.source, AMENDMENT_INDEXES_ROOT))

      OB_AMENDMENT_TYPES.each do |amendment_type|
        json_index = self.generate_amendment_index_from_ob_issues(amendment_type)
        index_filename = "#{amendment_type}.json"
        self.write_amendment_index(json_index, index_filename)
      end
    end

    def generate_amendment_index_from_ob_issues(amendment_type)
      amendments = []

      # Collect amendments of given type across OB issues
      self.data['issues'].each do |issue|
        if issue['amendments'][amendment_type]
          issue['amendments'][amendment_type].each do |change|
            amendments.push change
          end
        end
      end

      return { 'items' => amendments }
    end

    def write_amendment_index(index, index_filename)
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
