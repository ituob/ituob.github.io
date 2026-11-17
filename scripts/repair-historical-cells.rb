#!/usr/bin/env ruby
# frozen_string_literal: true

# Recover truncated multiline cells lost by the historical extractor.
# Match the publication, issue, country, code and existing first line; authored
# normalized amendments remain byte-exact and take precedence over legacy prose.
require "yaml"
require "date"
require "open3"
require "set"

## Restore complete historical cells using canonical row identity.
module HistoricalCells
  RULES = [
    { publication: "E164_ACN", slug: "e164-acn", code: "country_code",
      field: "mobile_telephone_numbers", language: "en" },
    { publication: "E212_MNC", slug: "e212-mnc", code: "mcc_mnc_codes",
      field: "networks" }
  ].freeze

  module_function

  def load_yaml(text)
    YAML.safe_load(text, permitted_classes: [Date, Time, DateTime, Symbol], aliases: true)
  end

  def git(root, *args)
    output, error, status = Open3.capture3("git", *args, chdir: root.to_s)
    raise error unless status.success?

    output
  end

  def text(node)
    return "" unless node.is_a?(Hash)
    return node.fetch("text", "") if node["type"] == "text"
    return "\n" if node["type"] == "hard_break"

    children = Array(node["content"])
    separator = %w[table_cell table_header].include?(node["type"]) ? "\n" : ""
    children.map { |child| text(child) }.join(separator)
  end

  def identity(value)
    value.to_s.gsub(/[[:space:]\u00a0]+/, " ").strip
  end

  def table_rows(node, &block)
    return unless node.is_a?(Hash)

    yield node if node["type"] == "table_row"
    Array(node["content"]).each { |child| table_rows(child, &block) }
  end

  def source_patterns(document, publication)
    patterns = Hash.new { |hash, key| hash[key] = [] }
    Array(document&.fetch("messages", nil)).each do |message|
      next unless message.dig("target", "publication") == publication

      table_rows(message.dig("contents", "en")) do |row|
        cells = Array(row["content"])
        next unless cells.length == 3 && cells.all? { |cell| cell["type"] == "table_cell" }

        country, code, numbers = cells.map { |cell| text(cell).strip }
        code = code.gsub(/[[:space:]\u00a0]/, "")
        lines = numbers.split("\n").map(&:strip).reject(&:empty?)
        next unless lines.length > 1 && code.match?(/\A\d+\z/)

        key = [identity(country), code, lines.first]
        patterns[key] << lines.join("\n")
      end
    end
    # Conflicting source rows are ambiguous; leave them untouched.
    patterns.transform_values(&:uniq).select { |_, values| values.length == 1 }
            .transform_values(&:first)
  end

  def repair_file(path, patterns, rule)
    document = load_yaml(File.read(path))
    data = document["data"]
    return 0 unless data.is_a?(Hash)

    entries = data["entries"]
    entries = [entries] if entries.is_a?(Hash)
    entries = [data] unless entries.is_a?(Array)
    repaired = 0
    entries.each do |entry|
      next unless entry.is_a?(Hash)

      holder = rule[:language] ? entry[rule[:field]] : entry
      field = rule[:language] || rule[:field]
      next unless holder.is_a?(Hash) && holder[field].is_a?(String)

      country = entry["country_or_area"]
      next unless country.is_a?(Hash)

      code = entry[rule[:code]].to_s.gsub(/[[:space:]\u00a0]/, "")
      key = [identity(country["en"]), code, holder[field]]
      replacement = patterns[key]
      next unless replacement && replacement != holder[field]

      holder[field] = replacement
      repaired += 1
    end
    File.write(path, YAML.dump(document).delete_prefix("---\n")) if repaired.positive?
    repaired
  end

  def repair(data_root, data_ref, projection_root)
    authored = git(data_root, "ls-tree", "-r", "--name-only", data_ref, "--", "ob-issues").lines.to_set(&:strip)
    source_paths = git(data_root, "ls-tree", "-r", "--name-only", data_ref, "--", "issues").lines.to_set(&:strip)
    RULES.sum do |rule|
      repair_register(data_root, data_ref, projection_root, authored, source_paths, rule)
    end
  end

  def repair_register(data_root, data_ref, projection_root, authored, source_paths, rule)
    count = 0
    by_issue = Dir.glob(File.join(projection_root, "ob-issues", "*", rule[:slug], "*.yaml")).group_by do |path|
      File.basename(File.dirname(File.dirname(path)))
    end
    by_issue.each do |issue, paths|
      source = "issues/#{issue}/amendments.yaml"
      next unless source_paths.include?(source)
      # Authored rows are authoritative, including the matching change records.
      next if authored.any? { |path| path.start_with?("ob-issues/#{issue}/#{rule[:slug]}/") }

      patterns = source_patterns(load_yaml(git(data_root, "show", "#{data_ref}:#{source}")), rule[:publication])
      next if patterns.empty?

      paths.each { |path| count += repair_file(path, patterns, rule) }
      Dir.glob(File.join(projection_root, "datasets", "*", "changes", "#{issue}-*.yaml")).each do |path|
        document = load_yaml(File.read(path))
        next unless document["register"] == rule[:publication]

        count += repair_file(path, patterns, rule)
      end
    end
    count
  end
end

if $PROGRAM_NAME == __FILE__
  abort "usage: repair-historical-cells.rb DATA_ROOT DATA_REF PROJECTION_ROOT" unless ARGV.length == 3
  puts "Historical cell fields repaired: #{HistoricalCells.repair(*ARGV)}"
end
