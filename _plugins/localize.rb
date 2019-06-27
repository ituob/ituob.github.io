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
      active_lang = context['page']['lang']
      default_lang = context['site']['default_language']
      translatable[active_lang] || translatable[default_lang]
    end

  end
end

Liquid::Template.register_tag('trans', Jekyll::LocalizeKey)
