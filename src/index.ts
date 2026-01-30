import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

// NASA API base URLs - free with DEMO_KEY
const NASA_NEO_API = 'https://api.nasa.gov/neo/rest/v1';
const JPL_CAD_API = 'https://ssd-api.jpl.nasa.gov/cad.api';
const API_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

// Helper to fetch JSON with error handling
async function fetchJSON(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// Format date as YYYY-MM-DD
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

// Get date offset
function getDateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

const agent = await createAgent({
  name: 'asteroid-watch',
  version: '1.0.0',
  description: 'Near-Earth Object (NEO) tracker - monitor asteroids approaching Earth. Get hazard alerts, close approach data, and detailed asteroid information using live NASA data.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === FREE ENDPOINT: Overview ===
// Get today's NEO summary - perfect for trying the service
addEntrypoint({
  key: 'overview',
  description: 'FREE: Get today\'s Near-Earth Object summary - count, nearest asteroid, and hazardous objects count',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const today = formatDate(new Date());
    const neoData = await fetchJSON(
      `${NASA_NEO_API}/feed?start_date=${today}&end_date=${today}&api_key=${API_KEY}`
    );
    
    const todaysAsteroids = neoData.near_earth_objects[today] || [];
    const hazardous = todaysAsteroids.filter((a: any) => a.is_potentially_hazardous_asteroid);
    
    // Find closest approach
    let closest = null;
    let closestDistance = Infinity;
    
    for (const asteroid of todaysAsteroids) {
      for (const approach of asteroid.close_approach_data) {
        const dist = parseFloat(approach.miss_distance.kilometers);
        if (dist < closestDistance) {
          closestDistance = dist;
          closest = {
            name: asteroid.name,
            id: asteroid.id,
            distance_km: dist,
            distance_lunar: parseFloat(approach.miss_distance.lunar),
            velocity_kph: parseFloat(approach.relative_velocity.kilometers_per_hour),
            is_hazardous: asteroid.is_potentially_hazardous_asteroid,
          };
        }
      }
    }
    
    return {
      output: {
        date: today,
        total_asteroids: neoData.element_count,
        hazardous_count: hazardous.length,
        closest_approach: closest,
        data_source: 'NASA NEO API (live)',
        fetched_at: new Date().toISOString(),
        upgrade_hint: 'Use paid endpoints for detailed lookups, searches, and hazard reports',
      },
    };
  },
});

// === PAID ENDPOINT 1: Lookup ($0.001) ===
// Look up specific asteroid by ID
addEntrypoint({
  key: 'lookup',
  description: 'Look up a specific asteroid by NASA ID - get full orbital data, close approaches, and hazard assessment',
  input: z.object({
    asteroid_id: z.string().describe('NASA asteroid ID (e.g., "3542519" or "2000433" for Eros)'),
  }),
  price: { amount: 1000 }, // $0.001
  handler: async (ctx) => {
    const data = await fetchJSON(
      `${NASA_NEO_API}/neo/${ctx.input.asteroid_id}?api_key=${API_KEY}`
    );
    
    // Get recent close approaches
    const recentApproaches = (data.close_approach_data || [])
      .filter((a: any) => new Date(a.close_approach_date) >= new Date('2020-01-01'))
      .slice(0, 10)
      .map((a: any) => ({
        date: a.close_approach_date,
        distance_km: parseFloat(a.miss_distance.kilometers),
        distance_lunar: parseFloat(a.miss_distance.lunar),
        velocity_kph: parseFloat(a.relative_velocity.kilometers_per_hour),
        orbiting_body: a.orbiting_body,
      }));
    
    return {
      output: {
        id: data.id,
        name: data.name,
        designation: data.designation,
        nasa_jpl_url: data.nasa_jpl_url,
        is_potentially_hazardous: data.is_potentially_hazardous_asteroid,
        is_sentry_object: data.is_sentry_object,
        absolute_magnitude: data.absolute_magnitude_h,
        estimated_diameter: {
          min_km: data.estimated_diameter.kilometers.estimated_diameter_min,
          max_km: data.estimated_diameter.kilometers.estimated_diameter_max,
          min_m: data.estimated_diameter.meters.estimated_diameter_min,
          max_m: data.estimated_diameter.meters.estimated_diameter_max,
        },
        orbital_data: data.orbital_data ? {
          orbit_class: data.orbital_data.orbit_class?.orbit_class_type,
          orbit_class_description: data.orbital_data.orbit_class?.orbit_class_description,
          orbital_period_days: parseFloat(data.orbital_data.orbital_period || '0'),
          perihelion_distance_au: parseFloat(data.orbital_data.perihelion_distance || '0'),
          aphelion_distance_au: parseFloat(data.orbital_data.aphelion_distance || '0'),
          eccentricity: parseFloat(data.orbital_data.eccentricity || '0'),
          inclination_deg: parseFloat(data.orbital_data.inclination || '0'),
        } : null,
        recent_close_approaches: recentApproaches,
        fetched_at: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 2: Search ($0.002) ===
// Search for hazardous asteroids in a date range
addEntrypoint({
  key: 'search',
  description: 'Search for potentially hazardous asteroids in a date range (max 7 days)',
  input: z.object({
    start_date: z.string().optional().describe('Start date (YYYY-MM-DD), defaults to today'),
    days: z.number().min(1).max(7).optional().default(7).describe('Number of days to search (1-7)'),
    hazardous_only: z.boolean().optional().default(false).describe('Only return potentially hazardous asteroids'),
  }),
  price: { amount: 2000 }, // $0.002
  handler: async (ctx) => {
    const startDate = ctx.input.start_date || formatDate(new Date());
    const endDate = getDateOffset(ctx.input.days);
    
    const data = await fetchJSON(
      `${NASA_NEO_API}/feed?start_date=${startDate}&end_date=${endDate}&api_key=${API_KEY}`
    );
    
    const allAsteroids: any[] = [];
    for (const [date, asteroids] of Object.entries(data.near_earth_objects)) {
      for (const asteroid of asteroids as any[]) {
        if (ctx.input.hazardous_only && !asteroid.is_potentially_hazardous_asteroid) {
          continue;
        }
        
        const approach = asteroid.close_approach_data[0];
        allAsteroids.push({
          id: asteroid.id,
          name: asteroid.name,
          date: date,
          is_hazardous: asteroid.is_potentially_hazardous_asteroid,
          distance_km: parseFloat(approach.miss_distance.kilometers),
          distance_lunar: parseFloat(approach.miss_distance.lunar),
          velocity_kph: parseFloat(approach.relative_velocity.kilometers_per_hour),
          diameter_min_m: asteroid.estimated_diameter.meters.estimated_diameter_min,
          diameter_max_m: asteroid.estimated_diameter.meters.estimated_diameter_max,
        });
      }
    }
    
    // Sort by distance
    allAsteroids.sort((a, b) => a.distance_km - b.distance_km);
    
    return {
      output: {
        search_period: { start: startDate, end: endDate },
        total_found: allAsteroids.length,
        hazardous_count: allAsteroids.filter(a => a.is_hazardous).length,
        asteroids: allAsteroids.slice(0, 50), // Limit to 50
        fetched_at: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 3: Top Closest ($0.002) ===
// Get top closest approaches
addEntrypoint({
  key: 'top',
  description: 'Get top closest asteroid approaches - sorted by miss distance',
  input: z.object({
    period: z.enum(['week', 'month', 'year']).optional().default('week').describe('Time period'),
    limit: z.number().min(1).max(20).optional().default(10).describe('Number of results (1-20)'),
    max_distance_ld: z.number().optional().default(10).describe('Max distance in Lunar Distances (1 LD = 384,400 km)'),
  }),
  price: { amount: 2000 }, // $0.002
  handler: async (ctx) => {
    // Map period to days
    const periodDays = { week: 7, month: 30, year: 365 };
    const days = periodDays[ctx.input.period];
    const endDateStr = getDateOffset(days);
    
    // Use JPL Close Approach Data API
    const data = await fetchJSON(
      `${JPL_CAD_API}?dist-max=${ctx.input.max_distance_ld}LD&date-min=now&date-max=${endDateStr}&sort=dist&limit=${ctx.input.limit}`
    );
    
    const approaches = (data.data || []).map((row: any[]) => {
      const [des, orbit_id, jd, cd, dist, dist_min, dist_max, v_rel, v_inf, t_sigma, h] = row;
      return {
        designation: des,
        close_approach_date: cd,
        distance_au: parseFloat(dist),
        distance_km: parseFloat(dist) * 149597870.7,
        distance_lunar: parseFloat(dist) * 389.17,
        velocity_km_s: parseFloat(v_rel),
        absolute_magnitude: parseFloat(h),
        orbit_id: orbit_id,
      };
    });
    
    return {
      output: {
        period: ctx.input.period,
        max_distance_ld: ctx.input.max_distance_ld,
        count: approaches.length,
        total_in_database: data.total || data.count,
        closest_approaches: approaches,
        data_source: 'NASA/JPL SBDB Close Approach Data API (live)',
        fetched_at: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 4: Compare ($0.003) ===
// Compare multiple asteroids
addEntrypoint({
  key: 'compare',
  description: 'Compare multiple asteroids side by side - size, orbit, hazard level',
  input: z.object({
    asteroid_ids: z.array(z.string()).min(2).max(5).describe('NASA asteroid IDs to compare (2-5)'),
  }),
  price: { amount: 3000 }, // $0.003
  handler: async (ctx) => {
    const results = await Promise.all(
      ctx.input.asteroid_ids.map(async (id) => {
        try {
          const data = await fetchJSON(`${NASA_NEO_API}/neo/${id}?api_key=${API_KEY}`);
          
          // Find next close approach to Earth
          const futureApproaches = (data.close_approach_data || [])
            .filter((a: any) => new Date(a.close_approach_date) > new Date() && a.orbiting_body === 'Earth')
            .sort((a: any, b: any) => new Date(a.close_approach_date).getTime() - new Date(b.close_approach_date).getTime());
          
          const nextApproach = futureApproaches[0];
          
          return {
            id: data.id,
            name: data.name,
            is_hazardous: data.is_potentially_hazardous_asteroid,
            diameter_min_m: data.estimated_diameter.meters.estimated_diameter_min,
            diameter_max_m: data.estimated_diameter.meters.estimated_diameter_max,
            absolute_magnitude: data.absolute_magnitude_h,
            orbit_class: data.orbital_data?.orbit_class?.orbit_class_type || 'Unknown',
            orbital_period_days: parseFloat(data.orbital_data?.orbital_period || '0'),
            next_earth_approach: nextApproach ? {
              date: nextApproach.close_approach_date,
              distance_km: parseFloat(nextApproach.miss_distance.kilometers),
              velocity_kph: parseFloat(nextApproach.relative_velocity.kilometers_per_hour),
            } : null,
            error: null,
          };
        } catch (e: any) {
          return {
            id,
            name: null,
            error: e.message,
          };
        }
      })
    );
    
    // Calculate comparison stats
    const valid = results.filter(r => !r.error);
    const largest = valid.reduce((max, r) => 
      (r.diameter_max_m || 0) > (max?.diameter_max_m || 0) ? r : max, null as any);
    const mostHazardous = valid.filter(r => r.is_hazardous);
    
    return {
      output: {
        compared_count: ctx.input.asteroid_ids.length,
        successful_lookups: valid.length,
        asteroids: results,
        summary: {
          largest: largest ? { name: largest.name, diameter_max_m: largest.diameter_max_m } : null,
          hazardous_count: mostHazardous.length,
          hazardous_names: mostHazardous.map(h => h.name),
        },
        fetched_at: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 5: Report ($0.005) ===
// Full hazard assessment report
addEntrypoint({
  key: 'report',
  description: 'Comprehensive NEO hazard report - combines all data sources for full threat assessment',
  input: z.object({
    days_ahead: z.number().min(1).max(30).optional().default(7).describe('Days to look ahead (1-30)'),
    include_sentry: z.boolean().optional().default(true).describe('Include Sentry risk objects'),
  }),
  price: { amount: 5000 }, // $0.005
  handler: async (ctx) => {
    const today = formatDate(new Date());
    const endDate = getDateOffset(ctx.input.days_ahead);
    
    // Fetch NEO feed
    const neoData = await fetchJSON(
      `${NASA_NEO_API}/feed?start_date=${today}&end_date=${endDate}&api_key=${API_KEY}`
    );
    
    // Fetch closest approaches from JPL
    const cadData = await fetchJSON(
      `${JPL_CAD_API}?dist-max=10LD&date-min=now&date-max=${endDate}&sort=dist`
    );
    
    // Process NEO data
    const allAsteroids: any[] = [];
    const hazardousList: any[] = [];
    
    for (const [date, asteroids] of Object.entries(neoData.near_earth_objects)) {
      for (const asteroid of asteroids as any[]) {
        const approach = asteroid.close_approach_data[0];
        const entry = {
          id: asteroid.id,
          name: asteroid.name,
          date: date,
          is_hazardous: asteroid.is_potentially_hazardous_asteroid,
          is_sentry: asteroid.is_sentry_object,
          distance_km: parseFloat(approach.miss_distance.kilometers),
          distance_lunar: parseFloat(approach.miss_distance.lunar),
          velocity_kph: parseFloat(approach.relative_velocity.kilometers_per_hour),
          diameter_min_m: asteroid.estimated_diameter.meters.estimated_diameter_min,
          diameter_max_m: asteroid.estimated_diameter.meters.estimated_diameter_max,
        };
        
        allAsteroids.push(entry);
        if (asteroid.is_potentially_hazardous_asteroid) {
          hazardousList.push(entry);
        }
      }
    }
    
    // Sort by distance and get statistics
    allAsteroids.sort((a, b) => a.distance_km - b.distance_km);
    hazardousList.sort((a, b) => a.distance_km - b.distance_km);
    
    // Calculate daily breakdown
    const dailyBreakdown: Record<string, { total: number; hazardous: number }> = {};
    for (const [date, asteroids] of Object.entries(neoData.near_earth_objects)) {
      const dayAsteroids = asteroids as any[];
      dailyBreakdown[date] = {
        total: dayAsteroids.length,
        hazardous: dayAsteroids.filter(a => a.is_potentially_hazardous_asteroid).length,
      };
    }
    
    // Process CAD data for very close approaches
    const veryCloseApproaches = (cadData.data || [])
      .filter((row: any[]) => parseFloat(row[4]) < 0.05) // < 0.05 AU ≈ 19.5 LD
      .map((row: any[]) => ({
        designation: row[0],
        date: row[3],
        distance_au: parseFloat(row[4]),
        distance_lunar: parseFloat(row[4]) * 389.17,
        velocity_km_s: parseFloat(row[7]),
      }));
    
    return {
      output: {
        report_period: {
          start: today,
          end: endDate,
          days: ctx.input.days_ahead,
        },
        summary: {
          total_asteroids: neoData.element_count,
          hazardous_count: hazardousList.length,
          sentry_objects: allAsteroids.filter(a => a.is_sentry).length,
          very_close_approaches: veryCloseApproaches.length,
        },
        threat_level: hazardousList.length === 0 ? 'LOW' : 
                      hazardousList.some(h => h.distance_lunar < 5) ? 'ELEVATED' : 'NORMAL',
        daily_breakdown: dailyBreakdown,
        closest_10: allAsteroids.slice(0, 10),
        hazardous_asteroids: hazardousList.slice(0, 20),
        very_close_approaches: veryCloseApproaches,
        data_sources: [
          'NASA NEO API (live)',
          'NASA/JPL SBDB Close Approach Data API (live)',
        ],
        generated_at: new Date().toISOString(),
      },
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🌠 Asteroid Watch Agent running on port ${port}`);
console.log(`📡 Data sources: NASA NEO API, NASA/JPL SBDB CAD API`);

export default { port, fetch: app.fetch };
