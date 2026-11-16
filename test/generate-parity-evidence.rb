# frozen_string_literal: true

# Run the canonical gate and also retain every classified Jekyll variant.
require 'csv'
require 'digest'
require 'fileutils'
require 'find'
require 'json'
require 'set'
require 'tmpdir'

module ParityEvidence
  class << self
    attr_accessor :reads, :rows
  end
  self.reads = []
  self.rows = []

  module Reads
    def read(path, ...)
      if File.extname(path.to_s) == '.html'
        ParityEvidence.reads << path.to_s
        ParityEvidence.reads.shift while ParityEvidence.reads.length > 2
      end
      super
    end
  end

  module Comparisons
    def compare(deployed_html, actual_html)
      report = super
      deployed, local = ParityEvidence.reads
      raise 'Unexpected audit input paths' unless deployed.start_with?('reference/') && local.start_with?('build/')

      relative = deployed.delete_prefix('reference/')
      label, = classify_page(relative)
      exclusion = CROSS_LISTED_PAGES[relative]
      ParityEvidence.rows << {
        deployed: relative, local: local.delete_prefix('build/'), label: label,
        coverage: report.coverage,
        verdict: if exclusion
                   'cross-listed'
                 else
                   (report.coverage >= 0.95 ? 'pass' : 'fail')
                 end,
        exclusion: exclusion,
        deployed_sha256: Digest::SHA256.hexdigest(deployed_html),
        local_sha256: Digest::SHA256.hexdigest(actual_html)
      }
      report
    end

    private

    # Same membership test as normalize-and-any?, with a per-input-set cache.
    # No token, coverage, exclusion, or worst-variant rule is changed.
    def href_matches_any?(href, actual_hrefs)
      normalized = normalize_external_href(href)
      return false if normalized.nil?

      unless @evidence_hrefs.equal?(actual_hrefs)
        @evidence_hrefs = actual_hrefs
        @evidence_normalized_hrefs = actual_hrefs.map { |value| normalize_external_href(value) }.to_set
      end
      @evidence_normalized_hrefs.include?(normalized)
    end
  end
end

reference = File.realpath(ENV.fetch('DEPLOYED_SITE'))
build = File.expand_path(ENV.fetch('LOCAL_DIST'))
output = File.expand_path(ENV.fetch('OUTPUT_DIR', File.join(__dir__, '../docs/parity/printed-labels-notes')))
canonical = File.expand_path('../data-ob/scripts/parity_report.rb', __dir__)
FileUtils.mkdir_p(output)

Dir.mktmpdir('printed-labels-parity-') do |directory|
  # Pathname#find does not descend through a symlinked root directory.
  # Use real directories and read-only file links so the canonical walker
  # visits the same complete tree without copying the HTML contents.
  Find.find(reference) do |source|
    target = File.join(directory, 'reference', source.delete_prefix(reference).delete_prefix('/'))
    if File.directory?(source)
      FileUtils.mkdir_p(target)
    elsif File.file?(source)
      File.symlink(source, target)
    end
  end
  File.symlink(build, File.join(directory, 'build'))
  Dir.chdir(directory) do
    ENV['DEPLOYED_SITE'] = 'reference'
    ENV['LOCAL_DIST'] = 'build'
    ENV['OUTPUT_DIR'] = output
    require canonical
    File.singleton_class.prepend(ParityEvidence::Reads)
    Ituob::Auditors::ContentParity.prepend(ParityEvidence::Comparisons)
    run

    classified = collect_deployed_pages.filter_map do |relative|
      label, local, = classify_page(relative)
      next unless label
      next relative if ParityEvidence.rows.any? { |row| row[:deployed] == relative }
      raise "Comparison missing for #{relative}" if File.file?(local)

      ParityEvidence.rows << {
        deployed: relative, local: nil, label: label, coverage: 0.0,
        verdict: 'missing', exclusion: CROSS_LISTED_PAGES[relative],
        deployed_sha256: Digest::SHA256.file(File.join('reference', relative)).hexdigest,
        local_sha256: nil
      }
      relative
    end
    rows = ParityEvidence.rows.sort_by { |row| row[:deployed] }
    raise 'No classified variants found' if rows.empty?
    raise 'Variant collection mismatch' unless rows.map { |row| row[:deployed] } == classified.sort

    included = rows.reject { |row| row[:exclusion] }
    payload = {
      schema_version: 1, threshold: 0.95, classified_variants: rows.length,
      included_variants: included.length, excluded_variants: rows.length - included.length,
      local_pages: rows.map { |row| row[:label] }.uniq.length,
      variants: rows
    }
    File.write(File.join(output, 'parity_variants.json'), "#{JSON.pretty_generate(payload)}\n")
    CSV.open(File.join(output, 'parity_variants.csv'), 'w') do |csv|
      csv << %w[deployed local label coverage verdict exclusion deployed_sha256 local_sha256]
      rows.each do |row|
        csv << row.values_at(:deployed, :local, :label, :coverage, :verdict, :exclusion, :deployed_sha256,
                             :local_sha256)
      end
    end
    puts "#{included.count { |row| row[:coverage] >= 0.95 }}/#{included.length} included variants pass"
    exit 1 unless included.all? { |row| row[:coverage] >= 0.95 && row[:verdict] == 'pass' }
  end
end
