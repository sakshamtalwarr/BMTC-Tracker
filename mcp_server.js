#!/usr/bin/env node
/**
 * Zero-dependency Model Context Protocol (MCP) server for BMTC Live Bus Tracking
 * Can be plugged directly into Claude Desktop, Cursor, or Gemini CLI
 */

const readline = require('readline');
const { trackBus, searchBusStop, searchRoute } = require('./bmtc');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

const TOOLS = [
  {
    name: 'where_is_my_bus',
    description: 'Get live exact GPS location, direction, and ETA of any BMTC bus (e.g. KIA-7A, 500-D, 335-E) towards your destination or bus stand.',
    inputSchema: {
      type: 'object',
      properties: {
        route: {
          type: 'string',
          description: 'Bus route number (e.g. "KIA-7A", "500-D", "335-E", "MF-1")',
        },
        target_stop: {
          type: 'string',
          description: 'Optional name of your bus stop or destination to get ETA (e.g. "Silk Board", "Kadugodi", "Airport")',
        },
      },
      required: ['route'],
    },
  },
  {
    name: 'search_bmtc_stops',
    description: 'Find official BMTC bus stops matching a name query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Name of the stop or area (e.g. "HSR", "Majestic", "Airport")',
        },
      },
      required: ['query'],
    },
  },
];

function sendResponse(id, result, error = null) {
  const resp = { jsonrpc: '2.0', id };
  if (error) {
    resp.error = error;
  } else {
    resp.result = result;
  }
  process.stdout.write(JSON.stringify(resp) + '\n');
}

rl.on('line', async (line) => {
  if (!line.trim()) return;

  try {
    const req = JSON.parse(line);
    const { id, method, params } = req;

    if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'bmtc-live-mcp',
          version: '1.0.0',
        },
      });
      return;
    }

    if (method === 'notifications/initialized') {
      return; // Notification, no response needed
    }

    if (method === 'tools/list') {
      sendResponse(id, { tools: TOOLS });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params.name;
      const args = params.arguments || {};

      if (toolName === 'where_is_my_bus') {
        const result = await trackBus(args.route, args.target_stop);
        if (!result.success) {
          sendResponse(id, {
            content: [{ type: 'text', text: result.message }],
            isError: true,
          });
          return;
        }

        if (result.totalActiveBuses === 0) {
          sendResponse(id, {
            content: [
              {
                type: 'text',
                text: `No active live GPS buses found on route ${result.route} right now.`,
              },
            ],
          });
          return;
        }

        let summary = `Live status for route ${result.route} (${result.totalActiveBuses} active buses):\n\n`;
        result.buses.forEach((b, i) => {
          summary += `🚌 Bus ${i + 1}: ${b.vehicleNumber} (${b.serviceType})\n`;
          summary += `• Direction: ${b.direction}\n`;
          summary += `• Current position: Near ${b.currentLocation.nearestStop} (${b.currentLocation.distanceFromNearestStopKm} km away)\n`;
          summary += `• Live GPS: ${b.coordinates.lat}, ${b.coordinates.lon} (updated: ${b.lastUpdated})\n`;
          summary += `• Map: ${b.googleMapsLink}\n`;
          if (b.targetStopAnalysis) {
            const t = b.targetStopAnalysis;
            if (t.hasPassed) {
              summary += `• Target [${t.targetStop}]: Already passed\n`;
            } else {
              summary += `• Target [${t.targetStop}]: ~${t.distanceKm} km away (${t.stopsAway} stops), ETA ~${t.estimatedMinutes} mins\n`;
            }
          }
          summary += `\n`;
        });

        sendResponse(id, {
          content: [{ type: 'text', text: summary.trim() }],
        });
        return;
      }

      if (toolName === 'search_bmtc_stops') {
        const stops = await searchBusStop(args.query);
        const text =
          stops.length > 0
            ? stops
                .slice(0, 10)
                .map((s) => `• ${s.stationname || s.stationName} (ID: ${s.stationid || s.stationId})`)
                .join('\n')
            : `No stops found for "${args.query}"`;

        sendResponse(id, {
          content: [{ type: 'text', text }],
        });
        return;
      }

      sendResponse(id, null, { code: -32601, message: `Tool not found: ${toolName}` });
      return;
    }

    sendResponse(id, null, { code: -32601, message: `Method not found: ${method}` });
  } catch (e) {
    sendResponse(null, null, { code: -32700, message: `Parse error: ${e.message}` });
  }
});
