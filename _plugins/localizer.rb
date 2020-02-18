module Jekyll

  # Localizes a template variable the value of which is an object (hash)
  # containing translated strings under language keys.
  #
  #   { <language1>: <string>, <language2>: <string> }
  #
  # The target language for localization is taken from page’s `lang` variable.
  # If the translation for the target language is not specified,
  # `site.default_language` is used.
  #
  # Example:
  #
  #   ```
  #   ---
  #   lang: en
  #   hello:
  #     en: hello
  #     ja: こんにちは
  #   ---
  #
  #   {% trans page.hello %}
  #   ```
  #
  # (This example seems pretty useless, the mechanism is mostly intended to work with
  # page context populated automatically, not through manual data entry in frontmatter.)
  class LocalizeKey < Liquid::Tag

    def initialize(tag_name, key, tokens)
      super
      @key = key.strip
    end

    def render(context)
      translatable = context[@key]
      report = context.registers[:site].config['report_missing_translations'] == true

      # Try borrowing issue from immediate context, falling back to page.issue
      issue = context['issue'] || context['page']['issue']

      page = if issue then issue['meta']['id'].to_s else context['page']['meta'] end

      active_lang = context['page']['lang']
      default_lang = context['site']['default_language']

      result = nil

      if translatable
        if translatable[active_lang]
          result = translatable[active_lang]
        elsif translatable[default_lang]
          if report
            p "Translations: #{issue_id}: Missing for #{@key}: #{translatable}"
          end
          result = translatable[default_lang]
        else
          if report
            p "Translations: #{issue_id}: Non-translatable: #{@key}: #{translatable}"
          end
          result = translatable
        end
      end

      result
    end

  end

  # Converts specified AsciiDoc file into HTML,
  # using path <OB issue path>/<page.lang>-<filename>,
  # falling back to <OB issue path>/<site.default_language>-<filename>,
  # falling back to <OB issue path>/<filename>.
  #
  # Localization behavior resembles the one of the {% trans %} tag.
  #
  # Currently, only AsciiDoc files are supported.
  #
  # Example:
  #
  #   ```
  #   ---
  #   lang: en
  #   file: iptn.adoc
  #   ---
  #
  #   {% trans_file page.file %}
  #   ```
  class LocalizeProcessFile < Liquid::Tag

    def initialize(tag_name, key, tokens)
      super
      @key = key.strip
    end

    def render(context)
      path = context[@key]

      # Try borrowing issue from immediate context, falling back to page.issue
      issue = context['issue'] || context['page']['issue']
      issue_id = issue['meta']['id'].to_s

      if not path or path == {}
        p "ERROR: L10N: trans_file passed empty string or object in issue #{issue_id}, #{@key}"
        return nil
      end

      path_components = path.split(File::SEPARATOR)
      filename = path_components.pop
      file_path = File.join(*path_components)

      issue_path = File.join(
        context['site']['source'],
        context['site']['ob_root'],
        issue_id)

      active_lang = context['page']['lang']
      default_lang = context['site']['default_language']

      fpath_candidates = [
        File.join(issue_path, file_path, "#{active_lang}-#{filename}"),
        File.join(issue_path, file_path, "#{default_lang}-#{filename}"),
        File.join(issue_path, file_path, filename),
      ]

      result = nil

      fpath_candidates.each do |fpath|
        if File.file?(fpath)
          contents = File.read(fpath)
          result = Asciidoctor.convert contents, safe: :server
          break
        end
      end

      if result == nil
        p "Error: L10N: #{issue_id} Couldn’t parse referenced file: #{@key}: #{filename}"
      end

      result
    end

  end
end

Liquid::Template.register_tag('trans', Jekyll::LocalizeKey)
Liquid::Template.register_tag('trans_file', Jekyll::LocalizeProcessFile)
