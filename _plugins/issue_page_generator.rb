module Jekyll

  class OBIssue < Page
    def initialize(site, base_dir, issue_dir, issue_id, issue_data, language='en')
      @site = site
      @base = base_dir
      @dir = "#{issue_dir}-#{language}"
      @name = "index.html"

      # Ignore OB issue unless it has a publication date.
      # TODO: Check that the date is in the future.
      unless issue_data['meta']['publication_date']
        return false
      end
      # Tack another convenience property onto issue_data
      issue_data['running_annexes_ordered'] = issue_data['running_annexes'].sort_by { |id, data|
        data['annexed_to_ob']
      }.reverse()

      self.process(@name)

      self.data = {
        'layout' => 'issue',
        'lang' => language,
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
      if issue_data['meta']['languages']
        issue_data['meta']['languages'].each do |lang, _|
          self.pages << OBIssue.new(self, self.source, path, issue_id, issue_data, lang)
        end
      else
        self.pages << OBIssue.new(self, self.source, path, issue_id, issue_data)
      end
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
