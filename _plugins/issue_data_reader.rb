require 'pathname'
require 'asciidoctor'

OB_DATE_FORMAT = '%Y-%m-%d'

module Jekyll

  class Site
    OB_ROOT = '_issues'
    PUB_ROOT = '_lists'

    def load_data(fname, path, optional=false)
      fpath = File.join(path, fname)
      if not optional or File.file?(fpath)
        return YAML.load(File.read(fpath))
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
      self.data['issues'] = {}
      self.data['current_annexes'] = {}

      self.get_issues().each do |issue_path|
        issue_data = {
          'meta' => self.load_data('meta.yaml', issue_path),
          'general' => self.load_data('general.yaml', issue_path, optional: true),
          'amendments' => self.load_data('amendments.yaml', issue_path, optional: true),
          'annexes' => self.load_data('annexes.yaml', issue_path, optional: true),
        }
        issue_id = issue_data['meta']['id']

        if issue_data['amendments']
          issue_data['amendments']['messages'].each do |msg|
            if msg['type'] == 'amendment'
              self.process_amendment(msg, issue_id)
            end
          end
        end

        if issue_data['annexes']
          issue_data['annexes'].each do |publication_id, publication_issue_data|
            self.update_current_annexes_with(
              publication_id,
              publication_issue_data,
              issue_id)
          end
        end

        # Snapshot latest annexes up to this issue
        issue_data['running_annexes'] = Marshal.load(Marshal.dump(self.data['current_annexes']))

        self.data['issues'][issue_id] = issue_data
      end

      issues_seq_desc = self.data['issues'].keys.sort_by(&:to_i).reverse()
      self.data['latest_issue_id'] = issues_seq_desc[0]
      self.data['previous_issue_id'] = issues_seq_desc[1]
      self.data['issue_ids_descending'] = issues_seq_desc
    end

    # Adds an issue (specified by issue_data)
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
        p "WARNING: Publication metadata not found for List #{publication_id}, annexed to OB #{issue_id}"
      end

      self.data['current_annexes'][publication_id] = {
        'annexed_to_ob' => ob_issue_id,
        'position_on' => current_position,
      }
    end

    # Associates an amendment with the original publication.
    # Infers & fills in useful amendment information
    # (publication title, amendment counter, etc.)
    def process_amendment(amendment, ob_issue_id)
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

    # Resolves the original publication from given amendment target.
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
  end

  class OBDataReader < Generator
    safe true
    priority :high

    def generate(site)
      site.read_publications
      site.read_ob_issues
    end
  end

end
