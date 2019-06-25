module Jekyll

  class OBIssue < Page
    def initialize(site, base_dir, issue_dir, issue_id, issue_data)
      @site = site
      @base = base_dir
      @dir = issue_dir
      @name = "index.html"

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

      self.data['issues'].each do |issue_id, issue_data|
        self.write_ob_issue(
          File.join(base_path, issue_id.to_s),
          issue_id,
          issue_data)
      end
    end

    def write_ob_issue(path, issue_id, issue_data)
      self.pages << OBIssue.new(self, self.source, path, issue_id, issue_data)
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
