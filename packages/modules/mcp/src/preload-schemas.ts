// 出厂默认参数结构（2026-09-30 用户口令「先配置套默认参数」）：连实况 server 抓取的真实 inputSchema
// 烤进代码——新机器冷进程从第一个请求起就带参数面（本地缓存 ~/.orosus/cache/mcp-preload-schemas.json
// 叠加在本层之上，首连后自然刷新应对 server 升级）。生成方式：scripts 一次性连五件预装 listTools
// （github 无令牌未捕获——首次带令牌使用时落盘缓存补上）。清单名与 preload.ts manifest 对齐。
import type { PreloadSchemaCache } from "./preload.ts";

export const BUNDLED_PRELOAD_SCHEMAS: PreloadSchemaCache = {
	"memory": {
		"create_entities": {
			"type": "object",
			"properties": {
				"entities": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"name": {
								"type": "string",
								"description": "The name of the entity"
							},
							"entityType": {
								"type": "string",
								"description": "The type of the entity"
							},
							"observations": {
								"type": "array",
								"items": {
									"type": "string"
								},
								"description": "An array of observation contents associated with the entity"
							}
						},
						"required": ["name", "entityType", "observations"]
					}
				}
			},
			"required": ["entities"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"create_relations": {
			"type": "object",
			"properties": {
				"relations": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"from": {
								"type": "string",
								"description": "The name of the entity where the relation starts"
							},
							"to": {
								"type": "string",
								"description": "The name of the entity where the relation ends"
							},
							"relationType": {
								"type": "string",
								"description": "The type of the relation"
							}
						},
						"required": ["from", "to", "relationType"]
					}
				}
			},
			"required": ["relations"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"add_observations": {
			"type": "object",
			"properties": {
				"observations": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"entityName": {
								"type": "string",
								"description": "The name of the entity to add the observations to"
							},
							"contents": {
								"type": "array",
								"items": {
									"type": "string"
								},
								"description": "An array of observation contents to add"
							}
						},
						"required": ["entityName", "contents"]
					}
				}
			},
			"required": ["observations"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"delete_entities": {
			"type": "object",
			"properties": {
				"entityNames": {
					"type": "array",
					"items": {
						"type": "string"
					},
					"description": "An array of entity names to delete"
				}
			},
			"required": ["entityNames"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"delete_observations": {
			"type": "object",
			"properties": {
				"deletions": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"entityName": {
								"type": "string",
								"description": "The name of the entity containing the observations"
							},
							"observations": {
								"type": "array",
								"items": {
									"type": "string"
								},
								"description": "An array of observations to delete"
							}
						},
						"required": ["entityName", "observations"]
					}
				}
			},
			"required": ["deletions"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"delete_relations": {
			"type": "object",
			"properties": {
				"relations": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"from": {
								"type": "string",
								"description": "The name of the entity where the relation starts"
							},
							"to": {
								"type": "string",
								"description": "The name of the entity where the relation ends"
							},
							"relationType": {
								"type": "string",
								"description": "The type of the relation"
							}
						},
						"required": ["from", "to", "relationType"]
					},
					"description": "An array of relations to delete"
				}
			},
			"required": ["relations"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"read_graph": {
			"type": "object",
			"properties": {},
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"search_nodes": {
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "The search query to match against entity names, types, and observation content"
				}
			},
			"required": ["query"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"open_nodes": {
			"type": "object",
			"properties": {
				"names": {
					"type": "array",
					"items": {
						"type": "string"
					},
					"description": "An array of entity names to retrieve"
				}
			},
			"required": ["names"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		}
	},
	"context7": {
		"resolve-library-id": {
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "What to look up in the library's documentation. This is used to rank library results by relevance to what the user is trying to accomplish. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query."
				},
				"libraryName": {
					"type": "string",
					"description": "Library name to search for and retrieve a Context7-compatible library ID. Use the official library name with proper punctuation — e.g., 'Next.js' instead of 'nextjs', 'Customer.io' instead of 'customerio', 'Three.js' instead of 'threejs'."
				}
			},
			"required": ["query", "libraryName"],
			"$schema": "https://json-schema.org/draft/2020-12/schema"
		},
		"query-docs": {
			"type": "object",
			"properties": {
				"libraryId": {
					"type": "string",
					"description": "Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'resolve-library-id' or directly from user query in the format '/org/project' or '/org/project/version'."
				},
				"query": {
					"type": "string",
					"description": "What to look up in the library's documentation, scoped to a single concept. Be specific and include relevant details, but keep each query to one topic — if the user's question spans multiple distinct concepts, make a separate call per concept instead of combining them, unless the question is about how the concepts interact. Good: 'How to set up authentication with JWT in Express.js' or 'React useEffect cleanup function examples'. Bad (too vague): 'auth' or 'hooks'. Bad (too broad): 'routing and auth and caching in Next.js'. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query."
				}
			},
			"required": ["libraryId", "query"],
			"$schema": "https://json-schema.org/draft/2020-12/schema"
		}
	},
	"everything": {
		"echo": {
			"type": "object",
			"properties": {
				"message": {
					"type": "string",
					"description": "Message to echo"
				}
			},
			"required": ["message"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"get-sum": {
			"type": "object",
			"properties": {
				"a": {
					"type": "number",
					"description": "First number"
				},
				"b": {
					"type": "number",
					"description": "Second number"
				}
			},
			"required": ["a", "b"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"simulate-research-query": {
			"type": "object",
			"properties": {
				"topic": {
					"type": "string",
					"description": "The research topic to investigate"
				},
				"ambiguous": {
					"default": false,
					"description": "Simulate an ambiguous query that requires clarification (triggers input_required status)",
					"type": "boolean"
				}
			},
			"required": ["topic"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"get-tiny-image": {
			"type": "object",
			"properties": {},
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"get-env": {
			"type": "object",
			"properties": {},
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"trigger-long-running-operation": {
			"type": "object",
			"properties": {
				"duration": {
					"default": 10,
					"description": "Duration of the operation in seconds",
					"type": "number"
				},
				"steps": {
					"default": 5,
					"description": "Number of steps in the operation",
					"type": "number"
				}
			},
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"toggle-subscriber-updates": {
			"type": "object",
			"properties": {},
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"toggle-simulated-logging": {
			"type": "object",
			"properties": {},
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"get-annotated-message": {
			"type": "object",
			"properties": {
				"messageType": {
					"type": "string",
					"enum": ["error", "success", "debug"],
					"description": "Type of message to demonstrate different annotation patterns"
				},
				"includeImage": {
					"default": false,
					"description": "Whether to include an example image",
					"type": "boolean"
				}
			},
			"required": ["messageType"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"get-structured-content": {
			"type": "object",
			"properties": {
				"location": {
					"type": "string",
					"enum": ["New York", "Chicago", "Los Angeles"],
					"description": "Choose city"
				}
			},
			"required": ["location"],
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"get-resource-links": {
			"type": "object",
			"properties": {
				"count": {
					"default": 3,
					"description": "Number of resource links to return (1-10)",
					"type": "number",
					"minimum": 1,
					"maximum": 10
				}
			},
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"get-resource-reference": {
			"type": "object",
			"properties": {
				"resourceType": {
					"default": "Text",
					"type": "string",
					"enum": ["Text", "Blob"]
				},
				"resourceId": {
					"default": 1,
					"description": "ID of the text resource to fetch",
					"type": "number"
				}
			},
			"$schema": "http://json-schema.org/draft-07/schema#"
		},
		"gzip-file-as-resource": {
			"type": "object",
			"properties": {
				"name": {
					"default": "README.md.gz",
					"type": "string",
					"description": "Name of the output file"
				},
				"data": {
					"default": "https://raw.githubusercontent.com/modelcontextprotocol/servers/refs/heads/main/README.md",
					"type": "string",
					"format": "uri",
					"description": "URL or data URI of the file content to compress"
				},
				"outputType": {
					"default": "resourceLink",
					"description": "How the resulting gzipped file should be returned. 'resourceLink' returns a link to a resource that can be read later, 'resource' returns a full resource object.",
					"type": "string",
					"enum": ["resourceLink", "resource"]
				}
			},
			"$schema": "http://json-schema.org/draft-07/schema#"
		}
	},
	"puppeteer": {
		"puppeteer_navigate": {
			"type": "object",
			"properties": {
				"url": {
					"type": "string",
					"description": "URL to navigate to"
				},
				"launchOptions": {
					"type": "object",
					"description": "PuppeteerJS LaunchOptions. Default null. If changed and not null, browser restarts. Example: { headless: true, args: ['--no-sandbox'] }"
				},
				"allowDangerous": {
					"type": "boolean",
					"description": "Allow dangerous LaunchOptions that reduce security. When false, dangerous args like --no-sandbox will throw errors. Default false."
				}
			},
			"required": ["url"]
		},
		"puppeteer_screenshot": {
			"type": "object",
			"properties": {
				"name": {
					"type": "string",
					"description": "Name for the screenshot"
				},
				"selector": {
					"type": "string",
					"description": "CSS selector for element to screenshot"
				},
				"width": {
					"type": "number",
					"description": "Width in pixels (default: 800)"
				},
				"height": {
					"type": "number",
					"description": "Height in pixels (default: 600)"
				},
				"encoded": {
					"type": "boolean",
					"description": "If true, capture the screenshot as a base64-encoded data URI (as text) instead of binary image content. Default false."
				}
			},
			"required": ["name"]
		},
		"puppeteer_click": {
			"type": "object",
			"properties": {
				"selector": {
					"type": "string",
					"description": "CSS selector for element to click"
				}
			},
			"required": ["selector"]
		},
		"puppeteer_fill": {
			"type": "object",
			"properties": {
				"selector": {
					"type": "string",
					"description": "CSS selector for input field"
				},
				"value": {
					"type": "string",
					"description": "Value to fill"
				}
			},
			"required": ["selector", "value"]
		},
		"puppeteer_select": {
			"type": "object",
			"properties": {
				"selector": {
					"type": "string",
					"description": "CSS selector for element to select"
				},
				"value": {
					"type": "string",
					"description": "Value to select"
				}
			},
			"required": ["selector", "value"]
		},
		"puppeteer_hover": {
			"type": "object",
			"properties": {
				"selector": {
					"type": "string",
					"description": "CSS selector for element to hover"
				}
			},
			"required": ["selector"]
		},
		"puppeteer_evaluate": {
			"type": "object",
			"properties": {
				"script": {
					"type": "string",
					"description": "JavaScript code to execute"
				}
			},
			"required": ["script"]
		}
	}
};
