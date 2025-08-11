export const config = {
  runtime: 'edge',
  maxDuration: 30, // Set maximum duration if available on your plan
};

export default async function handler(request) {
  // Original handleRequest function starts here
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  try {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/hash/")) {
      return await handleHashRequest(request, url);
    }
    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
  // End of handleRequest
}

// Rest of the original functions...
async function getCookiesFromKV() {
  try {
    const cookieData = JSON.parse(process.env.COOKIE_DATA || "[]");
    if (!cookieData || !Array.isArray(cookieData)) {
      console.warn("No valid cookie data found in env");
      return [];
    }
    return cookieData;
  } catch (error) {
    console.error("Error parsing cookies from env:", error);
    return [];
  }
}

// Simplified season and episode detection
function detectSeasonAndEpisodeFromUrl(url) {
  // Look for s followed by numbers (season)
  const seasonMatch = url.match(/s(\d{1,2})/i);
  const seasonNumber = seasonMatch ? parseInt(seasonMatch[1]) : 1;

  // Look for e followed by numbers (episode)
  const episodeMatch = url.match(/e(\d{1,2})/i);
  const episodeNumber = episodeMatch ? parseInt(episodeMatch[1]) : null;

  return { seasonNumber, episodeNumber };
}

// New function to get show logos from TMDB
async function getShowLogos(tvId, tmdbApiKey) {
  try {
    const imagesResponse = await fetch(`https://api.themoviedb.org/3/tv/${tvId}/images?api_key=${tmdbApiKey}&include_image_language=en,null`);
    const imagesData = await imagesResponse.json();
    
    let logoUrl = null;
    if (imagesData.logos && imagesData.logos.length > 0) {
      // Find English logo first, fallback to any logo
      const englishLogo = imagesData.logos.find(logo => logo.iso_639_1 === 'en');
      const selectedLogo = englishLogo || imagesData.logos[0];
      logoUrl = `https://image.tmdb.org/t/p/original${selectedLogo.file_path}`;
    }
    
    return logoUrl;
  } catch (error) {
    console.error('Error fetching show logos:', error);
    return null;
  }
}

// New function to get trailer URL
async function getTrailerUrl(tvId, tmdbApiKey) {
  try {
    const videosResponse = await fetch(`https://api.themoviedb.org/3/tv/${tvId}/videos?api_key=${tmdbApiKey}&language=en-US`);
    const videosData = await videosResponse.json();
    
    let trailerUrl = null;
    if (videosData.results && videosData.results.length > 0) {
      // Look for official trailer first
      const trailer = videosData.results.find(video => 
        video.type === 'Trailer' && 
        video.site === 'YouTube' && 
        video.official === true
      ) || videosData.results.find(video => 
        video.type === 'Trailer' && 
        video.site === 'YouTube'
      ) || videosData.results.find(video => 
        video.site === 'YouTube'
      );
      
      if (trailer) {
        trailerUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
      }
    }
    
    return trailerUrl;
  } catch (error) {
    console.error('Error fetching trailer URL:', error);
    return null;
  }
}

// Optimized batch processing for episodes
async function processBatch(batch, tvId, tmdbApiKey, cookieHeader) {
  const batchPromises = batch.map(async (episode) => {
    try {
      // Get episode metadata from TMDB
      const episodeResponse = await fetch(
        `https://api.themoviedb.org/3/tv/${tvId}/season/${episode.seasonNumber}/episode/${episode.episodeNumber}?api_key=${tmdbApiKey}&append_to_response=credits,images,external_ids`
      );
      const episodeData = await episodeResponse.json();

      if (episodeData.success === false) {
        return {
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
          error: episodeData.status_message || "Episode not found",
        };
      }

      // Fetch episode page with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout per episode

      try {
        const epPageResponse = await fetch(episode.url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-LK,en;q=0.9,si;q=0.8",
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
            "Cookie": cookieHeader,
          },
        });
        clearTimeout(timeoutId);

        if (!epPageResponse.ok) {
          return {
            seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber,
            error: `Failed to fetch episode page: ${epPageResponse.status}`,
          };
        }

        const epHtmlContent = await epPageResponse.text();
        const extractedData = extractPageData(epHtmlContent, episode.url);
        const downloadLinks = await fetchDownloadLinks(extractedData, episode.url, cookieHeader);

        return {
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
          episodeTitle: episodeData.name || null,
          overview: episodeData.overview || null,
          airDate: episodeData.air_date || null,
          runtime: episodeData.runtime || null,
          productionCode: episodeData.production_code || null,
          stillPath: episodeData.still_path ? `https://image.tmdb.org/t/p/original${episodeData.still_path}` : null,
          voteAverage: episodeData.vote_average || null,
          voteCount: episodeData.vote_count || null,
          crew: episodeData.credits?.crew?.slice(0, 5).map(member => ({
            id: member.id,
            name: member.name,
            job: member.job,
            department: member.department,
            profileUrl: member.profile_path ? `https://image.tmdb.org/t/p/original${member.profile_path}` : null,
          })) || [],
          guestStars: episodeData.credits?.guest_stars?.slice(0, 5).map(star => ({
            id: star.id,
            name: star.name,
            character: star.character,
            profileUrl: star.profile_path ? `https://image.tmdb.org/t/p/original${star.profile_path}` : null,
          })) || [],
          downloadLinks: groupLinksByQualityAndSize(downloadLinks),
        };
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          return {
            seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber,
            error: "Episode page fetch timeout",
          };
        }
        throw fetchError;
      }
    } catch (error) {
      console.error(`Error processing episode ${episode.episodeNumber}:`, error);
      return {
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        error: `Failed to process episode: ${error.message}`,
      };
    }
  });

  return await Promise.all(batchPromises);
}

async function handleHashRequest(request, url) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Decode base64 URL
  const base64 = url.pathname.split("/hash/")[1];
  let targetUrl;
  try {
    targetUrl = atob(base64);
    new URL(targetUrl); // Validate URL
  } catch (error) {
    return new Response(JSON.stringify({ error: "Invalid base64 encoded URL" }), {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const cookies = await getCookiesFromKV();
  const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  const tmdbApiKey = "e9b08082909c15ce0702a117a0d9fc8a";

  try {
    // Step 1: Fetch the series page with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const mainPageResponse = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-LK,en;q=0.9,si;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Cookie": cookieHeader,
      },
    });
    clearTimeout(timeoutId);

    if (!mainPageResponse.ok) {
      throw new Error(`Failed to fetch series page: ${mainPageResponse.status}`);
    }

    const htmlContent = await mainPageResponse.text();

    // Extract IMDb link
    const imdbLinkMatch = htmlContent.match(/<a[^>]*class=["']btn["'][^>]*href=["'](https:\/\/www\.imdb\.com\/title\/[^"']+)["'][^>]*data-lity/i);
    const imdbLink = imdbLinkMatch ? imdbLinkMatch[1] : null;

    if (!imdbLink) {
      return new Response(JSON.stringify({ error: "Could not find IMDb link on the page" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const imdbId = imdbLink.match(/tt\d+/i)?.[0];
    if (!imdbId) {
      return new Response(JSON.stringify({ error: "Invalid IMDb ID format" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Step 2: Extract episode links with simplified season and episode detection
    const episodeLinks = [];
    const episodeLinkPattern = /<a class="epi_item" href=["'](https:\/\/cineru\.lk\/[^"']+)["'][^>]*>Episode \d+(?:-end)?\s*<\/a>/gi;
    let episodeMatch;
    while ((episodeMatch = episodeLinkPattern.exec(htmlContent)) !== null) {
      const epUrl = episodeMatch[1];
      const { seasonNumber, episodeNumber } = detectSeasonAndEpisodeFromUrl(epUrl);
      
      if (episodeNumber) {
        episodeLinks.push({
          url: epUrl,
          seasonNumber: seasonNumber,
          episodeNumber: episodeNumber,
        });
      }
    }

    if (episodeLinks.length === 0) {
      // Try alternative pattern if first one fails
      const altEpisodeLinkPattern = /<a[^>]*href=["'](https:\/\/cineru\.lk\/[^"']*e\d{1,2}[^"']*)["'][^>]*>Episode \d+/gi;
      let altEpisodeMatch;
      while ((altEpisodeMatch = altEpisodeLinkPattern.exec(htmlContent)) !== null) {
        const epUrl = altEpisodeMatch[1];
        const { seasonNumber, episodeNumber } = detectSeasonAndEpisodeFromUrl(epUrl);
        
        if (episodeNumber) {
          episodeLinks.push({
            url: epUrl,
            seasonNumber: seasonNumber,
            episodeNumber: episodeNumber,
          });
        }
      }

      if (episodeLinks.length === 0) {
        return new Response(JSON.stringify({
          error: "No episode links found on the series page",
          details: "No URLs matching the episode pattern were found",
          debug: {
            targetUrl: targetUrl,
            htmlSnippet: htmlContent.substring(0, 1000) // First 1000 chars for debugging
          }
        }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    // Step 3: Get TMDB ID from IMDb ID
    const findResponse = await fetch(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbApiKey}&external_source=imdb_id`);
    const findData = await findResponse.json();

    const tvId = findData.tv_results[0]?.id;
    if (!tvId) {
      return new Response(JSON.stringify({ error: "Could not find TV show on TMDB" }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Step 4: Get show-wide data (logo, trailer) in parallel
    const [logoUrl, trailerUrl] = await Promise.all([
      getShowLogos(tvId, tmdbApiKey),
      getTrailerUrl(tvId, tmdbApiKey)
    ]);

    // Step 5: Group episodes by season
    const episodesBySeason = episodeLinks.reduce((acc, episode) => {
      if (!acc[episode.seasonNumber]) {
        acc[episode.seasonNumber] = [];
      }
      acc[episode.seasonNumber].push(episode);
      return acc;
    }, {});

    // Step 6: Process each season with optimized batching
    const allSeasonsData = {};
    const BATCH_SIZE = 4; // Process 4 episodes concurrently per batch
    
    for (const [seasonNumber, seasonEpisodes] of Object.entries(episodesBySeason)) {
      const seasonNum = parseInt(seasonNumber);
      
      // Get season details
      const seasonResponse = await fetch(`https://api.themoviedb.org/3/tv/${tvId}/season/${seasonNum}?api_key=${tmdbApiKey}`);
      const seasonData = await seasonResponse.json();
      
      let seasonPosterPath = null;
      let seasonOverview = "No season overview available";
      let seasonVoteAverage = null;
      
      if (seasonResponse.ok && seasonData.success !== false) {
        seasonPosterPath = seasonData.poster_path;
        seasonOverview = seasonData.overview || "No season overview available";
        seasonVoteAverage = seasonData.vote_average || null;
      }

      // Process episodes in batches to avoid timeout
      const allEpisodeDetails = [];
      let hasValidDownloadLinks = false;

      for (let i = 0; i < seasonEpisodes.length; i += BATCH_SIZE) {
        const batch = seasonEpisodes.slice(i, i + BATCH_SIZE);
        const batchResults = await processBatch(batch, tvId, tmdbApiKey, cookieHeader);
        
        // Check if any episode in this batch has valid download links
        batchResults.forEach(episode => {
          if (episode.downloadLinks && episode.downloadLinks.length > 0) {
            hasValidDownloadLinks = true;
          }
        });

        allEpisodeDetails.push(...batchResults);
      }

      // Store season data with enhanced information
      allSeasonsData[seasonNum] = {
        seasonNumber: seasonNum,
        seasonOverview: seasonOverview,
        seasonPosterPath: seasonPosterPath ? `https://image.tmdb.org/t/p/original${seasonPosterPath}` : null,
        seasonVoteAverage: seasonVoteAverage,
        episodes: allEpisodeDetails,
        hasValidDownloadLinks: hasValidDownloadLinks,
      };
    }

    // Check if any season has valid download links
    const hasAnyValidDownloadLinks = Object.values(allSeasonsData).some(season => season.hasValidDownloadLinks);

    if (!hasAnyValidDownloadLinks) {
      return new Response(JSON.stringify({
        success: false,
        error: "No valid download links found for any episode in any season",
      }), {
        status: 404,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Construct response with all seasons and enhanced metadata
    const responseData = {
      metadata: {
        tvShowId: tvId,
        tvShowTitle: findData.tv_results[0]?.name || null,
        tvShowVoteAverage: findData.tv_results[0]?.vote_average || null,
        tvShowVoteCount: findData.tv_results[0]?.vote_count || null,
        imdbId: imdbId,
        imdbUrl: imdbLink,
        tmdbUrl: `https://www.themoviedb.org/tv/${tvId}`,
        logoUrl: logoUrl,
        trailerUrl: trailerUrl,
        totalSeasons: Object.keys(allSeasonsData).length,
      },
      seasons: allSeasonsData,
    };

    return new Response(JSON.stringify({
      success: true,
      data: responseData,
    }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}

const googleDriveApiKey = "AIzaSyDOHwxICizvWKOCcj5pGMQHGdSbYd3NWRI";

async function fetchGoogleDriveFileInfo(driveUrl) {
  try {
    const fileIdMatch = driveUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (!fileIdMatch) {
      return { quality: 'unknown', size: 'unknown', mimeType: 'video/mp4' };
    }
    const fileId = fileIdMatch[1];
    
    // Add timeout to Google Drive API call
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout
    
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,size,mimeType,videoMediaMetadata&key=${googleDriveApiKey}`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      console.error('Google Drive API error:', await response.text());
      return { quality: 'unknown', size: 'unknown', mimeType: 'video/mp4' };
    }
    const data = await response.json();
    let size = 'unknown';
    if (data.size) {
      const bytes = parseInt(data.size);
      size = convertBytesToHuman(bytes);
    }
    let quality = 'unknown';
    if (data.videoMediaMetadata) {
      const vmm = data.videoMediaMetadata;
      const height = vmm.height;
      if (height) {
        if (height <= 360) quality = '360p';
        else if (height <= 480) quality = '480p';
        else if (height <= 720) quality = '720p';
        else if (height <= 1080) quality = '1080p';
        else if (height <= 1440) quality = '1440p';
        else if (height <= 2160) quality = '4K';
        else quality = `${height}p`;
      } else if (vmm.durationMillis && data.size) {
        const durationSec = vmm.durationMillis / 1000;
        const bitrate = (parseInt(data.size) * 8) / durationSec / 1000; // kbps
        if (bitrate < 800) quality = '360p';
        else if (bitrate < 1500) quality = '480p';
        else if (bitrate < 3000) quality = '720p';
        else if (bitrate < 6000) quality = '1080p';
        else quality = '4K+';
      }
    }
    const mimeType = data.mimeType || 'video/mp4';
    return { quality, size, mimeType };
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Google Drive API timeout');
    } else {
      console.error('Error fetching Google Drive info:', error);
    }
    return { quality: 'unknown', size: 'unknown', mimeType: 'video/mp4' };
  }
}

async function fetchPixeldrainFileInfo(url) {
  try {
    const idMatch = url.match(/\/u\/([a-zA-Z0-9]+)/);
    if (!idMatch) {
      return { quality: 'unknown', size: 'unknown', mimeType: 'video/mp4' };
    }
    const id = idMatch[1];
    
    // Add timeout to Pixeldrain API call
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout
    
    const response = await fetch(`https://pixeldrain.com/api/file/${id}/info`, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      return { quality: 'unknown', size: 'unknown', mimeType: 'video/mp4' };
    }
    const data = await response.json();
    const size = convertBytesToHuman(data.size);
    const mimeType = data.mime_type || 'video/mp4';
    const quality = 'unknown';
    return { quality, size, mimeType };
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Pixeldrain API timeout');
    } else {
      console.error('Error fetching Pixeldrain info:', error);
    }
    return { quality: 'unknown', size: 'unknown', mimeType: 'video/mp4' };
  }
}

function convertBytesToHuman(bytes) {
  if (typeof bytes !== 'number' || isNaN(bytes)) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function convertSizeFormat(size) {
  if (size === 'unknown') return size;

  const sizeMatch = size.match(/^(\d+\.?\d*)\s*(MB|GB|KB)$/i);
  if (!sizeMatch) return size;

  let value = parseFloat(sizeMatch[1]);
  const unit = sizeMatch[2].toUpperCase();

  if (unit === 'MB' && value >= 1000) {
    value = (value / 1000).toFixed(2);
    return `${value} GB`;
  }
  if (unit === 'KB' && value >= 1000) {
    value = (value / 1000).toFixed(2);
    return `${value} MB`;
  }
  return `${value.toFixed(2)} ${unit}`;
}

function groupLinksByQualityAndSize(links) {
  const grouped = {};

  links.forEach(link => {
    const key = `${link.quality || 'unknown'}_${link.size || 'unknown'}`;
    if (!grouped[key]) {
      grouped[key] = {
        quality: link.quality || 'unknown',
        size: link.size || 'unknown',
        mimeType: link.mimeType || 'unknown',
        sources: [],
      };
    }
    grouped[key].sources.push({
      type: link.type,
      url: link.url,
    });
  });

  return Object.values(grouped);
}

function extractPageData(htmlContent, baseUrl) {
  const postIdMatch = htmlContent.match(/<input[^>]*id=["']post_id["'][^>]*value=["']([^"']+)["']/i);
  const postId = postIdMatch ? postIdMatch[1] : null;

  const urlObj = new URL(baseUrl);
  const baseDomain = `${urlObj.protocol}//${urlObj.host}`;

  return {
    postId,
    baseDomain,
    ajaxUrl: `${baseDomain}/wp-admin/admin-ajax.php`,
  };
}

async function fetchDownloadLinks(extractedData, originalUrl, cookieHeader) {
  const downloadLinks = [];

  if (!extractedData.postId) {
    return downloadLinks;
  }

  try {
    const formData = new FormData();
    formData.append('action', 'cs_download_data');
    formData.append('post_id', extractedData.postId);

    // Add timeout to AJAX request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    const ajaxResponse = await fetch(extractedData.ajaxUrl, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-LK,en;q=0.9,si;q=0.8",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": originalUrl,
        "Cookie": cookieHeader,
      },
    });
    clearTimeout(timeoutId);

    if (ajaxResponse.ok) {
      const ajaxData = await ajaxResponse.text();
      let parsedData;
      try {
        parsedData = JSON.parse(ajaxData);
        if (parsedData.data) {
          const links = await extractDownloadLinksFromHtml(parsedData.data);
          downloadLinks.push(...links);
        }
      } catch (e) {
        const links = await extractDownloadLinksFromHtml(ajaxData);
        downloadLinks.push(...links);
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Download links fetch timeout');
    } else {
      console.error('Error fetching download links:', error);
    }
  }

  return downloadLinks;
}

async function extractDownloadLinksFromHtml(htmlContent) {
  const links = [];

  // Extract HC panel content if present
  let panelContent = htmlContent;
  const hcPanelMatch = htmlContent.match(/<div[^>]*id=["']hc_panel["'][^>]*>([\s\S]*?)<\/div>/i);
  if (hcPanelMatch) {
    panelContent = hcPanelMatch[1];
  }

  // Patterns applied to the panel content
  const gdrivePattern = /<span[^>]*class=["'][^"']*btn-gdrive[^"']*hc_film[^"']*["'][^>]*data-link=["'](https:\/\/drive\.google\.com\/[^"']+)["']/gi;
  const pixeldrainPattern = /<span[^>]*class=["'][^"']*btn-pixeldrain[^"']*["'][^>]*data-link=["'](https:\/\/pixeldrain\.com\/[^"']+)["']/gi;

  let gdriveMatch;
  while ((gdriveMatch = gdrivePattern.exec(panelContent)) !== null) {
    const cleanUrl = gdriveMatch[1].replace(/['">\s]+$/, '');
    links.push({
      type: 'google_drive',
      url: cleanUrl,
      quality: 'unknown',
      size: 'unknown',
      mimeType
