# frozen_string_literal: true
# message_type_page_generator.rb
#
# New-pipeline message-type page generator. Emits:
#   /types/{type}/index.html — cross-issue aggregation of one message type
#
# Only active when site.config['rendering_pipeline'] == 'new'.

module Jekyll
  class MessageTypePage < Page
    def initialize(site, type, messages_by_issue)
      @site = site
      @base = site.source
      @dir = File.join('types', type)
      @name = 'index.html'
      self.process(@name)
      self.data = {
        'layout' => 'message_type',
        'message_type' => type,
        'messages_by_issue' => messages_by_issue,
      }
    end
  end

  class Site
    def write_message_type_pages
      return unless config['rendering_pipeline'] == 'new'
      issues = (data['ob'] || {})['issues'] || {}
      by_type = Hash.new { |h, k| h[k] = {} }
      issues.each do |iid, idata|
        (idata['general_messages'] || {}).each do |type, msgs|
          by_type[type][iid] = msgs
        end
      end
      by_type.each do |type, msgs_by_issue|
        pages << MessageTypePage.new(self, type, msgs_by_issue)
      end
    end
  end

  class MessageTypePageGenerator < Generator
    safe true
    priority :low

    def generate(site)
      site.write_message_type_pages
    end
  end
end
