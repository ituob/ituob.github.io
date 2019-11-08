require 'open-uri'
require 'nokogiri'


module Jekyll
  class Site

    def load_approved_recommendations_message(msg, issue_id)
      msg['items'] = msg['items'].map { |code, version|
        version_as_date = nil
        if version.is_a?(Date)
          version_as_date = version
        else
          year, month = version.split('-')
          version_as_date = Date.new(year.to_i, month.to_i, 1)
        end
        [code, version_as_date]
      }.to_h

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
        version = "#{version.month.to_s}/#{version.year.to_s[-2..-1]}"

        begin
          title = self.fetch_recommendation_title(rec, version)
        rescue
          p "ERROR: Failed to fetch recommendation title for #{rec} #{version}"
          title = ""
        end

        # If successful, add title to recommendation data dynamically
        if title != ""
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
