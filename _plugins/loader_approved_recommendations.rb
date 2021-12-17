require 'open-uri'
require 'nokogiri'
require 'relaton'

module Jekyll
  class Site
    def load_approved_recommendations_message(msg, issue_id, issue_meta)
      msg['items'] = msg['items'].map { |code, version|
        version_as_date = nil
        if version.is_a?(Date)
          version_as_date = version
        elsif version.is_a?(Time)
          # NOTE: It really shouldn’t be a time.
          version_as_date = version.to_date
        else
          begin
            year, month = version.split('-')
            version_as_date = Date.new(year.to_i, (month or '1').to_i, 1)
          rescue
            year, month, day = version.split('-')
            version_as_date = Date.new(year.to_i, (month or '1').to_i, (day or '1').to_i)
          end
        end
        [code, version_as_date]
      }.to_h

      # results = Queue.new
      @db ||= Relaton::DbCache.init_bib_caches(local_cache: 'relaton')
      msg['items'].each do |rec, version|
        # Check if recommendation already has metadata in YAML database
        existing_rec = data['recommendations'][rec]
        next if existing_rec

        data['recommendations'][rec] = { 'meta' => { 'code' => rec } }

        # Fetch English title for the recommendation
        version = version.strftime "(%m/%Y)"

      #   @db.fetch_async("ITU-T " + rec.strip) do |bib|
      #     title = if bib
      #               bib.title.detect { |t| t.type == 'main' }&.title&.content.to_s
      #             else
      #               p "ERROR: Failed to fetch recommendation title for #{rec} #{version}"
      #               ""
      #             end
      #     results << { rec: rec, title: title } # fetch_recommendation_title(rec, version)
      #   end
      # end

      # msg['items'].size.times do
      #   t = results.pop
        begin
          title = fetch_recommendation_title(rec, version)
        rescue StandardError => e
          puts "ERROR: Error thrown when fetching recommendation title for #{rec} #{version}"
          p e.inspect
          title = nil
        end

        if title.nil?
          puts "WARNING: No title retrieved for recommendation #{rec} #{version}"
          next
        end

        # If successful, add title to recommendation data dynamically
        data['recommendations'][rec]['meta']['title'] = { 'en' => title }
      end
    end

    def fetch_recommendation_title(rec, version)
      ref = "ITU-T #{rec.strip}"
      ref += " #{version.strip}" if version && !version.empty?
      bib = @db.fetch ref
      return nil unless bib

      bib.title.detect { |t| t.type == 'main' }&.title&.content.to_s
    end
  end
end
