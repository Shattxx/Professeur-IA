import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import fetch from 'node-fetch';

export interface ScrapedContent {
  title: string;
  content: string;
  markdown: string;
  siteName: string;
  images: { url: string; alt: string }[];
}

export async function fetchAndClean(url: string): Promise<ScrapedContent> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    throw new Error(`Could not parse content from ${url}`);
  }

  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced'
  });

  const markdown = turndownService.turndown(article.content);

  // Extract images from the main content
  const images: { url: string; alt: string }[] = [];
  const contentDoc = new JSDOM(article.content).window.document;
  const imgElements = contentDoc.querySelectorAll('img');
  
  imgElements.forEach(img => {
    const src = img.getAttribute('src');
    if (src) {
      // Resolve relative URLs
      const absoluteUrl = new URL(src, url).href;
      images.push({
        url: absoluteUrl,
        alt: img.getAttribute('alt') || ''
      });
    }
  });

  return {
    title: article.title,
    content: article.content,
    markdown,
    siteName: article.siteName || new URL(url).hostname,
    images
  };
}
