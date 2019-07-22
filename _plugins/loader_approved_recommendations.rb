require 'open-uri'
require 'nokogiri'


module Jekyll
  class Site

    def load_approved_recommendations_message(msg, issue_id)
      msg['items'].each do |rec, version|
        # Check if recommendation already has a title in YAML database
        existing_rec = self.data['recommendations'][rec]
        if existing_rec
          if existing_rec['meta']['title']['en']
            next
          end
        else
          self.data['recommendations'][rec] = {
            'meta' => { 'code' => rec, }
          }
        end

        # Fetch English title for the recommendation
        year, month = version.split('-')
        version = "#{month}/#{year[-2..-1]}"

        begin
          title = self.fetch_recommendation_title(rec, version)
        rescue
          p "ERROR: Failed to fetch recommendation title for #{rec} #{version}"
          title = ""
        end

        # If successful, add title to recommendation data dynamically
        if title
          self.data['recommendations'][rec]['meta']['title'] = {
            'en' => title,
          }
        end
      end
    end

    def fetch_recommendation_title(code, version)
      raise 'Fetching recommendation titles was disabled '\
        'to keep site build times reasonable '\
        'and avoid accidentally DoSing ITU-T site during active development'

      raw_doc = URI.parse("https://www.itu.int/rec/T-REC-#{code}/en").read
      doc = Nokogiri::HTML(raw_doc)
      title_node = doc.at("td > a > strong:contains(\"#{code}\"):contains(\"(#{version})\")")
      title_node.parent.parent.next_element.text.strip.chomp(' ').strip
    end

  end
end
