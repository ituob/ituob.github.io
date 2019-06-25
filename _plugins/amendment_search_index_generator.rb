module Jekyll

  class Site

    OB_AMENDMENT_TYPES = {
      'ships_maritime' => lambda { |item| item['type'] == 'ships_maritime' },
    }
    AMENDMENT_INDEXES_ROOT = File.join("data", "amendment_indexes")

    def write_amendment_search_indexes
      FileUtils.mkdir_p(File.join(self.source, AMENDMENT_INDEXES_ROOT))

      OB_AMENDMENT_TYPES.each do |amendment_type, checker|
        notices = self.filter_notices(checker)
        index_filename = "#{amendment_type}.json"
        self.write_amendment_index({ 'notices' => notices }, index_filename)
      end
    end

    def filter_notices(checker)
      amendments = []

      # Collect amendments of given type across OB issues
      self.data['issues'].each do |issue_id, issue_data|
        issue_data['amendments']['notices'].each do |notice|
          if checker.call(notice)
            amendments.push notice
          end
        end
      end

      amendments
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
