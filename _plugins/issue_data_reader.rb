require 'pathname'
require 'asciidoctor'

OB_DATE_FORMAT = '%Y-%m-%d'

module Jekyll

  class Site
    OB_ROOT = File.join('data', 'issues')
    PUB_ROOT = File.join('data', 'lists')
    REC_ROOT = File.join('data', 'recommendations')

    def load_data(fname, path, optional=false)
      fpath = File.join(path, fname)
      if not optional or File.file?(fpath)
        return YAML.load(File.read(fpath))
      end
    end

    def read_recommendations
      self.data['recommendations'] = {}

      self.get_recommendations().each do |rec_path|
        rec_data = {
          'meta' => self.load_data('meta.yaml', rec_path),
        }
        rec_code = rec_data['meta']['code']
        self.data['recommendations'][rec_code] = rec_data
      end
    end

    def read_publications
      self.data['publications'] = {}

      self.get_publications().each do |pub_path|
        pub_data = {
          'meta' => self.load_data('meta.yaml', pub_path),
        }
        pub_id = pub_data['meta']['id']
        self.data['publications'][pub_id] = pub_data
      end
    end

    def read_ob_issues

      # Placeholder for OB edition (issue) data
      self.data['issues'] = {}

      # Placeholder for running annexes
      self.data['current_annexes'] = {}

      # Placeholder for planned issues schedule
      self.data['planned_issues'] = []

      # Collect issue IDs to sort later
      issues_seq_asc = []

      # Read issues from filesystem, in unspecified order
      self.get_issues().each do |issue_path|
        issue_data = {
          'meta' => self.load_data('meta.yaml', issue_path),
          'general' => self.load_data('general.yaml', issue_path, optional: true),
          'amendments' => self.load_data('amendments.yaml', issue_path, optional: true),
          'annexes' => self.load_data('annexes.yaml', issue_path, optional: true),
          'planned_issues' => [],
        }

        issue_id = issue_data['meta']['id']

        # Consider OB edition “incomplete” if it lacks either amendments or general section
        ['general', 'amendments'].each do |important_section|
          message_count = (issue_data[important_section] || {})['messages'].size
          if message_count < 1
            issue_data['incomplete'] = true
            break
          end
        end

        self.data['issues'][issue_id] = issue_data
        issues_seq_asc << issue_id
      end

      # Sort editions by numeric ID ascending (oldest first)
      issues_seq_asc = issues_seq_asc.sort_by(&:to_i)

      # Process edition data
      issues_seq_asc.each do |issue_id|
        # Get unprocessed data hash for the current edition
        issue_data = self.data['issues'][issue_id]

        # Obtain combined array of all messages
        messages =
          ((issue_data['amendments'] || {})['messages'] || []) +
          ((issue_data['general'] || {})['messages'] || [])

        # Process message data for message types
        # which have custom processing method provided
        # in corresponding loader plugin
        messages.each do |msg|
          loader_method = "load_#{msg['type']}_message"
          if self.respond_to? loader_method
            self.send(loader_method, msg, issue_id)
          end
        end

        # Process annexes added in this edition
        if issue_data['annexes']
          issue_data['annexes'].each do |publication_id, publication_issue_data|
            self.update_current_annexes_with(
              publication_id,
              publication_issue_data,
              issue_id)
          end
        end

        # Snapshot latest annexes up to this edition
        issue_data['running_annexes'] = Marshal.load(Marshal.dump(self.data['current_annexes']))

        # Back-fill scheduled issues for preceding editions
        self.backfill_planned_issue(issue_id)
      end

      # Obtain an array of complete (non-draft) issues, latest first
      issues_seq_desc = issues_seq_asc.select {
        |i_id| self.data['issues'][i_id]['meta']['publication_date'] < Date.today
      }.reverse()

      self.data['latest_issue_id'] = issues_seq_desc[0]
      self.data['previous_issue_id'] = issues_seq_desc[1]
      self.data['issue_ids_descending'] = issues_seq_desc

      self.data['current_annexes_ordered'] = self.data['current_annexes'].sort_by { |id, data|
        data['annexed_to_ob']
      }.reverse
    end

    # Add given OB edition to previous editions’ “planned issues” section
    def backfill_planned_issue(issue_id)
      self.data['issues'].each do |_iid, _idata|
        if issue_id > _iid
          issue_data = self.data['issues'][issue_id]
          _idata['planned_issues'] << {
            'id' => issue_data['meta']['id'],
            'publication_date' => issue_data['meta']['publication_date'],
            'cutoff_date' => issue_data['meta']['cutoff_date'],
          }
        end
      end
    end

    # Adds an issue/position (specified by issue_data)
    # of given publication/list/dataset (specified by publication_id)
    # to the list of current annexes.
    #
    # If publication was previously annexed with another position,
    # ensures that new position represents a later version/issue/snapshot
    # of publication/list/dataset.
    #
    # TODO: If there is a use case for retiring annexes, retire=true argument
    # can be added to drop given publication from current annexes.
    def update_current_annexes_with(publication_id, publication_issue_data, ob_issue_id)
      if publication_issue_data
        current_position = publication_issue_data['position_on']

        previously_annexed = self.data['current_annexes'][publication_id]
        if previously_annexed
          previous_position = previously_annexed['position_on']
          if current_position and previous_position
            if previous_position >= current_position
              p "WARNING: Newly annexed position of #{publication_id} #{current_position} must be later than previously annexed position #{previous_position}!"
            end
          else
            p "WARNING: Annexed publication #{publication_id} must specify annexed position always or never"
          end
        end

        if self.data['publications'][publication_id] == nil
          p "WARNING: Publication metadata not found for List #{publication_id}, annexed to OB #{ob_issue_id}"
        end

        self.data['current_annexes'][publication_id] = {
          'annexed_to_ob' => ob_issue_id,
          'position_on' => current_position,
        }
      else
        self.data['current_annexes'][publication_id] = {
          'annexed_to_ob' => ob_issue_id,
        }
      end
    end

    # Associates an amendment with the original publication.
    # Infers & fills in useful amendment information
    # (publication title, amendment counter, etc.)
    def load_amendment_message(amendment, ob_issue_id)
      if amendment['target']
        original_pub, current_annex = self.resolve_amendment_target(amendment['target'])

        if original_pub
          original_pub['amendments'] ||= []
          original_pub['amendments'] << {
            'changeset' => amendment['changeset'],
            'amended_in_ob_issue' => ob_issue_id,
          }

          if current_annex
            annexed_position = current_annex['position_on']
            if amendment['target']['position_on'] == annexed_position
              current_annex['amendments'] ||= []
              current_annex['amendments'] << {
                'amended_in_ob_issue' => ob_issue_id,
              }
              amendment['seq_no'] = current_annex['amendments'].size
            end
          end
        else
          p "WARNING: Original publication not found for amendment #{amendment['target']['publication']}"
        end
      else
        p "No target specified for amendment “#{amendment['title'] || amendment}” in OB #{ob_issue_id}"
      end
    end

    # Resolves the original publication and current annex, if any, given an amendment target.
    def resolve_amendment_target(amn_target)
      pub = self.data['publications'][amn_target['publication']]

      # Let’s see if amendment target is a previously annexed list position
      annexed_list = self.data['current_annexes'][amn_target['publication']]
      if annexed_list
        if annexed_list['position_on']
          if amn_target['position_on']
            if amn_target['position_on'] == annexed_list['position_on']
              return pub, annexed_list
            else
              p "WARNING: Trying to amend list #{amn_target['publication']} at position #{amn_target['position_on']}, while latest annexed position is #{annexed_list['position_on']}!"
            end
          else
            p "WARNING: Trying to amend list #{amn_target['publication']} annexed at position #{annexed_list['position_on']} without specifying position"
          end
        else
          p "WARNING: Annexed list #{amn_target['publication']} does not have position specified"
        end
      end

      return pub, nil
    end

    # Returns a list of OB_ROOT subdirectories (expected one for each OB issue)
    def get_issues
      Pathname(OB_ROOT).children.select(&:directory?).map(&:to_s).sort_by(&:to_i)
    end

    # Returns a list of PUB_ROOT subdirectories
    def get_publications
      Pathname(PUB_ROOT).children.select(&:directory?).map(&:to_s)
    end

    # Returns a list of REC_ROOT subdirectories
    def get_recommendations
      Pathname(REC_ROOT).children.select(&:directory?).map(&:to_s)
    end
  end

  class OBDataReader < Generator
    safe true
    priority :high

    def generate(site)
      site.read_recommendations
      site.read_publications
      site.read_ob_issues
    end
  end

end
