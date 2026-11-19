# frozen_string_literal: true

# Run the canonical gate and retain every classified Jekyll variant.
require 'csv'
require 'digest'
require 'delegate'
require 'fileutils'
require 'find'
require 'json'
require 'set'
require 'tmpdir'

module ParityEvidence
  # Keep canonical diagnostics while replacing the page-level scoring contract.
  class ScoredReport < SimpleDelegator
    attr_reader :coverage

    def initialize(report, coverage)
      super(report)
      @coverage = coverage
    end

    def to_report_hash
      super.merge(coverage: coverage.round(4))
    end
  end

  SOURCE_PATHS = %w[
    src/lib/printed-context.ts src/lib/loaders.ts src/lib/ob-date.ts
    src/components/PrintedRegisterContext.astro src/components/IncompleteBanner.astro
    src/components/ProseMirror.astro src/pages/issues/[id]/index.astro
    src/pages/registers/[slug]/index.astro package-lock.json
  ].freeze

  class << self
    attr_accessor :reads, :rows

    def verdict(coverage, exclusion)
      return 'cross-listed' if exclusion

      coverage >= 0.95 ? 'pass' : 'fail'
    end

    def record(report, contents)
      deployed, local = reads
      raise 'Unexpected audit input paths' unless deployed.start_with?('reference/') && local.start_with?('build/')

      relative = deployed.delete_prefix('reference/')
      rows << entry(report, [relative, local.delete_prefix('build/')], contents)
    end

    def entry(report, paths, contents)
      relative, local = paths
      exclusion = CROSS_LISTED_PAGES[relative]
      {
        deployed: relative, local: local, label: classify_page(relative).first,
        coverage: report.coverage, verdict: verdict(report.coverage, exclusion), exclusion: exclusion,
        deployed_sha256: Digest::SHA256.hexdigest(contents.first),
        local_sha256: Digest::SHA256.hexdigest(contents.last)
      }
    end
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
      report = ScoredReport.new(super, multiset_coverage(deployed_html, actual_html))
      ParityEvidence.record(report, [deployed_html, actual_html])
      report
    end

    private

    def multiset_coverage(deployed_html, actual_html)
      old_counts, new_counts = [deployed_html, actual_html].map do |html|
        root = main_element(parse_html(html))
        tokens_for(spaced_text(root)).tally
      end
      total = old_counts.values.sum
      return 1.0 if total.zero?

      old_counts.sum { |token, count| [count, new_counts.fetch(token, 0)].min }.to_f / total
    end

    # Same descendant text leaves as XPath, without libxml2's node sorting.
    def node_text(node)
      text_parts(node).join(' ').gsub(/\s+/, ' ').strip
    end

    def spaced_text(node)
      text_parts(node).join(' ')
    end

    def text_parts(root)
      return [] if ([root] + root.ancestors.to_a).any? { |node| hidden_text?(node) }

      parts = []
      stack = root.children.to_a.reverse
      until stack.empty?
        node = stack.pop
        collect_text_node(node, parts, stack) unless hidden_text?(node)
      end
      parts
    end

    def hidden_text?(node)
      %w[script style].include?(node.name)
    end

    def collect_text_node(node, parts, stack)
      if node.text? || node.cdata?
        parts << node.content
      else
        stack.concat(node.children.to_a.reverse)
      end
    end

    # Equivalent to normalize-and-any?, cached per immutable input set.
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

def stage_reference(reference, directory)
  # Pathname#find must see real directories, not a symlinked root.
  Find.find(reference) do |source|
    target = File.join(directory, 'reference', source.delete_prefix(reference).delete_prefix('/'))
    if File.directory?(source)
      FileUtils.mkdir_p(target)
    elsif File.file?(source)
      File.symlink(source, target)
    end
  end
end

def canonical_setup(canonical, output)
  ENV['DEPLOYED_SITE'] = 'reference'
  ENV['LOCAL_DIST'] = 'build'
  ENV['OUTPUT_DIR'] = output
  require canonical
  File.singleton_class.prepend(ParityEvidence::Reads)
  Ituob::Auditors::ContentParity.prepend(ParityEvidence::Comparisons)
end

def missing_comparison(relative, label, local)
  raise "Comparison missing for #{relative}" if File.file?(local)

  ParityEvidence.rows << {
    deployed: relative, local: nil, label: label, coverage: 0.0,
    verdict: 'missing', exclusion: CROSS_LISTED_PAGES[relative],
    deployed_sha256: Digest::SHA256.file(File.join('reference', relative)).hexdigest, local_sha256: nil
  }
end

def collected_rows
  classified = collect_deployed_pages.filter_map do |relative|
    label, local, = classify_page(relative)
    next unless label

    missing_comparison(relative, label, local) unless ParityEvidence.rows.any? { |row| row[:deployed] == relative }
    relative
  end
  rows = ParityEvidence.rows.sort_by { |row| row[:deployed] }
  validate_rows(rows, classified)
  rows
end

def validate_rows(rows, classified)
  raise 'No classified variants found' if rows.empty?
  raise 'Variant collection mismatch' unless rows.map { |row| row[:deployed] } == classified.sort
end

def evidence_payload(rows, source_hashes)
  included = rows.reject { |row| row[:exclusion] }
  {
    schema_version: 1, metric: 'multiset-token-containment', threshold: 0.95, classified_variants: rows.length,
    included_variants: included.length, excluded_variants: rows.length - included.length,
    local_pages: rows.map { |row| row[:label] }.uniq.length,
    source_sha256: source_hashes, variants: rows
  }
end

def write_evidence(output, rows, source_hashes)
  payload = evidence_payload(rows, source_hashes)
  File.write(File.join(output, 'parity_variants.json'), "#{JSON.pretty_generate(payload)}\n")
  CSV.open(File.join(output, 'parity_variants.csv'), 'w') do |csv|
    keys = %i[deployed local label coverage verdict exclusion deployed_sha256 local_sha256]
    csv << keys
    rows.each { |row| csv << row.values_at(*keys) }
  end
end

def evidence_verdict(rows)
  included = rows.reject { |row| row[:exclusion] }
  passed = included.count { |row| row[:coverage] >= 0.95 && row[:verdict] == 'pass' }
  puts "#{passed}/#{included.length} included variants pass"
  passed == included.length
end

if $PROGRAM_NAME == __FILE__
  reference = File.realpath(ENV.fetch('DEPLOYED_SITE'))
  build = File.expand_path(ENV.fetch('LOCAL_DIST'))
  output = File.expand_path(ENV.fetch('OUTPUT_DIR', File.join(__dir__, '../docs/parity/printed-labels-notes')))
  canonical = File.expand_path('../data-ob/scripts/parity_report.rb', __dir__)
  # A saved build must be attributed to its source checkout, not today's tree.
  repository = File.realpath(ENV.fetch('PARITY_SOURCE_ROOT', File.expand_path('..', __dir__)))
  source_hashes = ParityEvidence::SOURCE_PATHS.to_h do |path|
    [path, Digest::SHA256.file(File.join(repository, path)).hexdigest]
  end
  FileUtils.mkdir_p(output)
  Dir.mktmpdir('printed-labels-parity-') do |directory|
    stage_reference(reference, directory)
    File.symlink(build, File.join(directory, 'build'))
    Dir.chdir(directory) do
      canonical_setup(canonical, output)
      run
      rows = collected_rows
      write_evidence(output, rows, source_hashes)
      exit 1 unless evidence_verdict(rows)
    end
  end
end
