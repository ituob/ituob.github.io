require 'pathname'
require 'asciidoctor'


module Jekyll

  class Site
    ISSUES_ROOT = '_issues'

    def read_ob_issues
      self.data['issues'] = []

      self.get_issues().each do |issue_path|
        meta = File.read(File.join(issue_path, 'meta.yaml'))
        general = File.read(File.join(issue_path, 'general.yaml'))
        amendments = File.read(File.join(issue_path, 'amendments.yaml'))

        issue_data = {
          'meta' => YAML.load(meta),
          'general' => YAML.load(general),
          'amendments' => YAML.load(amendments),
        }

        begin
          communications = issue_data['general']['nnp']['communications']
        rescue
          p "No communications"
          communications = []
        end
        communications.each do |comm|
          contents = File.read(File.join(issue_path, 'nnp_communications', comm['_contents']))
          comm['contents_html'] = Asciidoctor.convert contents, safe: :server
        end

        self.data['issues'].push(issue_data)
      end
    end

    # Returns a list ISSUES_ROOT subdirectories (expected one for each OB issue)
    def get_issues
      Pathname(ISSUES_ROOT).children.select(&:directory?)
    end
  end

  class IssueDataReader < Generator
    safe true
    priority :high

    def generate(site)
      site.read_ob_issues
    end
  end

end
