module Jekyll

  class Site

    AMENDMENT_INDEXES_ROOT = File.join("data", "amendment_indexes")

    def write_amendment_search_indexes
      FileUtils.mkdir_p(File.join(self.source, AMENDMENT_INDEXES_ROOT))

      self.data['publications'].each do |pub_id, _|
        amendments = self.find_amendment_messages_for_publication(pub_id)
        index_filename = "#{pub_id}.json"
        self.write_amendment_index({ 'amendments' => amendments }, index_filename)
      end
    end

    def find_amendment_messages_for_publication(pub_id)
      amendments = []

      # Collect amendments of given type across OB issues
      self.data['issues'].each do |issue_id, issue_data|
        if issue_data['amendments']
          issue_data['amendments']['messages'].each do |msg|
            if msg['type'] == 'amendment'
              target = msg['target']
              if target != nil and target['publication'] == pub_id
                amendments.push msg
              end
            end
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
