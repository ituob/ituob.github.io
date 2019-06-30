module Jekyll

  MESSAGE_INDICES = {
    'by-pub-amended' => {
      'title' => 'Amending ITU-T Service Publication',
      'url_prefix' => 'amending-sp',
      'getter' => lambda { |msg, _|
        if msg['type'] == 'amendment'
          return msg['target']
        end
        return nil
      },
      'key_builder' => lambda { |val|
        "#{val['publication']} (#{val['position_on']})"
      },
    },
    'by-rec' => {
      'title' => 'Complement to ITU-T Recommendation',
      'url_prefix' => 'complement-to-itu-t-r',
      'getter' => lambda { |msg, site|
        if msg['type'] == 'amendment' and msg['target']['publication'] != nil
          pub = site.data['publications'][msg['target']['publication']]
          if pub
            pub_rec = pub['meta']['recommendation']
            return pub_rec
          end
        end
        return msg['recommendation'] || site.config['message_types'][msg['type']]['recommendation']
      },
      'key_builder' => lambda { |val| "#{val['code']}" },
    },
  }

  class MessageIndex < Page
    def initialize(site, base_dir, idx, key, meta, messages, years, year=nil)
      @site = site
      @base = base_dir

      url_prefix = MESSAGE_INDICES[idx]['url_prefix']
      if year
        @dir = File.join('messages', "#{url_prefix} #{key}", year.to_s)
      else
        @dir = File.join('messages', "#{url_prefix} #{key}")
      end

      @name = "index.html"

      self.process(@name)

      self.data = {
        'layout' => 'message_index',
        'years' => years,
        'year' => year,
        'meta' => meta,
        'title' => MESSAGE_INDICES[idx]['title'],
        'index_id' => idx,
        'key' => key,
        'messages' => messages,
      }
    end
  end

  class Site

    MESSAGE_INDICIES_ROOT = File.join('data', 'msg_index')

    def write_amendment_search_indexes
      FileUtils.mkdir_p(File.join(self.source, MESSAGE_INDICIES_ROOT))

      # self.data['publications'].each do |pub_id, _|
      #   amendments = self.find_amendment_messages_for_publication(pub_id)
      #   index_filename = "#{pub_id}.json"
      #   self.write_amendment_index({ 'amendments' => amendments }, index_filename)
      # end

      issue_messages = []
      self.data['issue_ids_descending'].each do |issue_id|
        issue_data = self.data['issues'][issue_id]
        ['general', 'amendments'].each do |section|
          if issue_data[section]
            issue_data[section]['messages'].each do |msg|
              issue_messages << { 'issue_id' => issue_id, 'msg' => msg }
            end
          end
        end
      end

      self.data['message_indices'] = {}

      MESSAGE_INDICES.each do |idx, config|
        keys = {}
        issue_messages.each do |item|
          val = config['getter'].call(item['msg'], self)
          next if val == nil

          key = config['key_builder'].call(val)
          keys[key] ||= {
            'meta' => val,
            'items' => [],
          }
          keys[key]['items'] << item
        end

        keys.each do |key, data|
          self.write_message_index(idx, key, data['meta'], data['items'])
        end

        self.data['message_indices'][idx] = keys
      end
    end

    def write_message_index(idx, key, meta, matches)
      matches_per_year = {}

      matches.each do |match|
        year = self.data['issues'][match['issue_id']]['meta']['publication_date'].year
        matches_per_year[year] ||= []
        matches_per_year[year] << match
      end

      years_descending = matches_per_year.keys.sort_by(&:to_i).reverse()
      latest_year = years_descending.shift
      years_descending.each do |current_year|
        self.pages << MessageIndex.new(
          self,
          self.source,
          idx,
          key,
          meta,
          matches_per_year[current_year],
          years_descending,
          current_year)
      end

      self.pages << MessageIndex.new(
        self,
        self.source,
        idx,
        key,
        meta,
        matches_per_year[latest_year],
        years_descending)
    end

    # def find_amendment_messages_for_publication(pub_id)
    #   amendments = []

    #   site.data['message_indices'] = {}

    #   # Collect amendments for given publication across OB issues
    #   self.data['issues'].each do |issue_id, issue_data|
    #     if issue_data['amendments']
    #       issue_data['amendments']['messages'].each do |msg|
    #         if msg['type'] == 'amendment'
    #           target = msg['target']
    #           if target
    #             target_pub_id = target['publication']
    #             if target_pub_id == pub_id
    #               # Collect amendment
    #               amendments.push msg

    #               # File under

    #               # Check if it’s amending an effective publication;
    #               # if so, increase amendment count under current_annexes
    #               current_annex = self.data['current_annexes'][pub_id]
    #               if current_annex
    #                 annexed_position = current_annex['position_on']
    #                 if target['position_on'] == annexed_position
    #                   current_annex['amendment_count'] ||= 0
    #                   current_annex['amendment_count'] += amendments.size
    #                 end
    #               end
    #             end
    #           end
    #         end
    #       end
    #     end
    #   end

    #   amendments
    # end

    # def write_amendment_index(index, index_filename)
    #   index_file_path = File.join(
    #     self.source,
    #     AMENDMENT_INDEXES_ROOT,
    #     index_filename)

    #   File.open(index_file_path, "w") do |f|
    #     f.write(JSON.pretty_generate(index))
    #   end

    #   self.static_files << Jekyll::StaticFile.new(
    #     self,
    #     self.source,
    #     AMENDMENT_INDEXES_ROOT,
    #     index_filename)
    # end
  end


  class PublicationAmendmentIndexGenerator < Generator
    safe true
    priority :low

    def generate(site)
      site.write_amendment_search_indexes
    end
  end

end
