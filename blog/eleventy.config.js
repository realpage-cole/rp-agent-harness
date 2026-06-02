import syntaxHighlight from "@11ty/eleventy-plugin-syntaxhighlight";
import { DateTime } from "luxon";
import markdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";

// The blog is always served under this path on munderdiffl.in. We prefix links
// explicitly (via the `u` filter) instead of Eleventy's pathPrefix, whose HTML
// auto-transform double-applies the prefix when combined with the `url` filter.
const BASE = "/blog";

export default function (eleventyConfig) {
  // ---- markdown: heading anchors so the TOC + deep links work ----
  const md = markdownIt({ html: true, linkify: true, typographer: true }).use(
    markdownItAnchor,
    {
      permalink: markdownItAnchor.permalink.linkInsideHeader({
        symbol: "#",
        class: "anchor",
        placement: "after",
        ariaHidden: true,
      }),
      level: [2, 3],
      slugify,
    }
  );
  eleventyConfig.setLibrary("md", md);

  // ---- plugins ----
  eleventyConfig.addPlugin(syntaxHighlight);

  // ---- passthrough static assets ----
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });

  // ---- collections ----
  // All published posts, newest first.
  eleventyConfig.addCollection("posts", (api) =>
    api
      .getFilteredByGlob("src/posts/*.md")
      .filter((p) => !p.data.draft)
      .sort((a, b) => b.date - a.date)
  );

  // Topic clusters (categories) — derived from each post's `category` field.
  eleventyConfig.addCollection("categories", (api) => {
    const map = {};
    for (const post of api.getFilteredByGlob("src/posts/*.md")) {
      if (post.data.draft) continue;
      const cat = post.data.category;
      if (!cat) continue;
      (map[cat] ||= []).push(post);
    }
    return Object.entries(map)
      .map(([name, posts]) => ({
        name,
        slug: slugify(name),
        posts: posts.sort((a, b) => b.date - a.date),
      }))
      .sort((a, b) => b.posts.length - a.posts.length);
  });

  // Flat tag list with counts.
  eleventyConfig.addCollection("tagList", (api) => {
    const counts = {};
    for (const post of api.getFilteredByGlob("src/posts/*.md")) {
      if (post.data.draft) continue;
      for (const tag of post.data.tags || []) {
        counts[tag] = (counts[tag] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .map(([name, count]) => ({ name, slug: slugify(name), count }))
      .sort((a, b) => b.count - a.count);
  });

  // ---- filters ----
  eleventyConfig.addFilter("slug", slugify);

  // Root-relative URL with the /blog base. Leaves absolute URLs untouched.
  eleventyConfig.addFilter("u", (p) => {
    if (p === undefined || p === null || p === "") return BASE + "/";
    if (/^https?:\/\//.test(String(p))) return p;
    const path = String(p).startsWith("/") ? p : "/" + p;
    return (BASE + path).replace(/([^:])\/{2,}/g, "$1/");
  });

  eleventyConfig.addFilter("readableDate", (d, zone = "utc") =>
    DateTime.fromJSDate(d, { zone }).toFormat("LLL d, yyyy")
  );
  eleventyConfig.addFilter("isoDate", (d) =>
    DateTime.fromJSDate(d, { zone: "utc" }).toISO()
  );
  eleventyConfig.addFilter("htmlDate", (d) =>
    DateTime.fromJSDate(d, { zone: "utc" }).toFormat("yyyy-LL-dd")
  );

  // Reading time from rendered HTML / raw content (~225 wpm).
  eleventyConfig.addFilter("readingTime", (content) => {
    const text = String(content || "").replace(/<[^>]+>/g, " ");
    const words = text.split(/\s+/).filter(Boolean).length;
    return Math.max(1, Math.round(words / 225));
  });

  eleventyConfig.addFilter("absoluteUrl", (path, base) => {
    try {
      return new URL(path, base).toString();
    } catch {
      return path;
    }
  });

  // Related posts: same category, excluding self, newest first.
  eleventyConfig.addFilter("relatedPosts", (collection, url, category, limit = 3) =>
    (collection || [])
      .filter((p) => p.url !== url && p.data.category === category)
      .sort((a, b) => b.date - a.date)
      .slice(0, limit)
  );

  // Build a table of contents from rendered post HTML (h2 + h3).
  eleventyConfig.addFilter("toc", (html) => {
    const items = [];
    const re = /<h([23])[^>]*\bid="([^"]+)"[^>]*>(.*?)<\/h\1>/gis;
    let m;
    while ((m = re.exec(String(html || "")))) {
      const level = Number(m[1]);
      const id = m[2];
      // strip the appended anchor link + any inline tags
      const text = m[3]
        .replace(/<a class="anchor"[\s\S]*?<\/a>/gi, "")
        .replace(/<[^>]+>/g, "")
        .trim();
      if (text) items.push({ level, id, text });
    }
    return items;
  });

  eleventyConfig.addFilter("byTag", (posts, tag) =>
    (posts || []).filter((p) => (p.data.tags || []).includes(tag))
  );

  eleventyConfig.addFilter("limit", (arr, n) => (arr || []).slice(0, n));
  eleventyConfig.addFilter("excludeSelf", (arr, url) =>
    (arr || []).filter((p) => p.url !== url)
  );

  // ---- config ----
  return {
    dir: {
      input: "src",
      output: "../docs/blog",
      includes: "_includes",
      data: "_data",
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
    templateFormats: ["njk", "md", "11ty.js"],
  };
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
}
