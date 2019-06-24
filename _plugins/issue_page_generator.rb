module Jekyll

  class OBIssue < Page
    def initialize(site, base_dir, issue_dir, issue_id)
      @site = site
      @base = base_dir
      @dir = issue_dir
      @name = "index.html"

      issue_data = site.data['issues'].detect { |i| i['meta']['id'] == issue_id }

      # Ignore OB issue unless it has a publication date.
      # TODO: Check that the date is in the future.
      unless issue_data['meta']['publication_date']
        return false
      end

      self.process(@name)

      self.data = {
        'layout' => 'issue',
        'issue' => issue_data,
      }
    end
  end


  class Site
    def write_ob_issues
      base_path = self.config['ob_issues_path'] || 'issues'

      self.data['issues'].each do |issue_data|
        issue_id = issue_data['meta']['id']
        self.write_ob_issue(
          File.join(base_path, issue_id.to_s),
          issue_id)
      end
    end

    def write_ob_issue(path, issue_id)
      self.pages << OBIssue.new(self, self.source, path, issue_id)
    end
  end


  class IssuePageGenerator < Generator
    safe true
    priority :low

    def generate(site)
      site.write_ob_issues
    end
  end

end
