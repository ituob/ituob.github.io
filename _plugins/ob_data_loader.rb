# frozen_string_literal: true
# ob_data_loader.rb
#
# New-pipeline data loader. Reads the normalized data shape from
# data-ob/ob-issues/ and data-ob/datasets/ and populates site.data.ob.*.
#
# This loader is feature-flagged behind site.config['rendering_pipeline'].
# When 'legacy', the loader is a no-op so the legacy pipeline keeps working.
#
# See TODO.new-structure/00-vision-and-target-architecture.adoc for the
# target shape and TODO.new-structure/08-redevelop-ituob-org-site.adoc for
# the rendering plan.

require 'pathname'
require 'yaml'

module Jekyll
  class Site
    OB_ISSUES_ROOT = 'data-ob/ob-issues'
    DATASETS_ROOT = 'data-ob/datasets'

    def read_ob_normalized
      return unless config['rendering_pipeline'] == 'new'

      data['ob'] = {
        'issues' => read_ob_normalized_issues,
        'datasets' => read_ob_normalized_datasets,
      }
    end

    def read_ob_normalized_issues
      out = {}
      path = OB_ISSUES_ROOT
      return out unless File.directory?(path)

      Pathname(path).children.select(&:directory?).each do |d|
        next unless d.basename.to_s =~ /\A\d+\z/
        issue_id = d.basename.to_s.to_i
        meta = load_yaml_safe(d.join('meta.yaml').to_s)
        annexes = load_yaml_safe(d.join('annexes.yaml').to_s)
        out[issue_id] = {
          'meta' => meta,
          'annexes' => annexes,
          'dataset_actions' => read_issue_dataset_actions(d),
          'general_messages' => read_issue_general_messages(d),
        }
      end
      out
    end

    def read_ob_normalized_datasets
      out = {}
      path = DATASETS_ROOT
      return out unless File.directory?(path)

      Pathname(path).children.select(&:directory?).each do |d|
        slug = d.basename.to_s
        out[slug] = {
          'metadata' => load_yaml_safe(d.join('metadata.yaml').to_s),
          'schema' => load_yaml_safe(d.join('schema-data.yaml').to_s),
          'data' => load_yaml_safe(d.join('data.yaml').to_s),
        }
      end
      out
    end

    def read_issue_dataset_actions(issue_dir)
      out = {}
      issue_dir.children.select(&:directory?).each do |sub|
        next if sub.basename.to_s == 'general'
        out[sub.basename.to_s] = sub.children.select(&:file?).map do |f|
          load_yaml_safe(f.to_s)
        end.compact
      end
      out
    end

    def read_issue_general_messages(issue_dir)
      out = {}
      general_dir = issue_dir.join('general')
      if general_dir.directory?
        general_dir.children.select(&:file?).each do |f|
          data = load_yaml_safe(f.to_s)
          key = File.basename(f, '.yaml')
          out[key] = data if data
        end
      end
      # Also bucket textual types (sanc, ipns, etc.) by type-name subdirectory.
      %w[sanc iptn ipns mid org_changes misc_communications
         service_restrictions custom callback_procedures telephone_service_2].each do |t|
        tdir = issue_dir.join(t)
        next unless tdir.directory?
        out[t] = tdir.children.select(&:file?).map { |f| load_yaml_safe(f.to_s) }.compact
      end
      out
    end

    def load_yaml_safe(path)
      return nil unless File.file?(path)
      YAML.safe_load(File.read(path), aliases: true,
                                    permitted_classes: [Date, Time, Symbol])
    end
  end

  class OBDataLoader < Generator
    safe true
    priority :high

    def generate(site)
      site.read_ob_normalized if site.config['rendering_pipeline'] == 'new'
    end
  end
end
