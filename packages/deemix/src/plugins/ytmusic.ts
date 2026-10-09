import { Collection, Convertable } from "@/download-objects/Collection.js";
import { PluginNotEnabledError } from "@/errors.js";
import { type Settings } from "@/types/Settings.js";
import { getConfigFolder } from "@/utils/localpaths.js";
import { queue } from "async";
import { createHash } from "crypto";
import { type Deezer } from "deezer-sdk";
import fs from "fs";
import got from "got";
import { sep } from "path";
import BasePlugin from "./base.js";

const YTM_ORIGIN = "https://music.youtube.com";
const YTM_API = `${YTM_ORIGIN}/youtubei/v1`;
const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
const MAX_PAGES = 100;

export const YTM_QUICK_PICKS_LINK = "ytmusic:quickpicks";
export const YTM_LIBRARY_SONGS_LINK = `${YTM_ORIGIN}/library/songs`;

export interface YTMusicTrack {
	videoId: string;
	title: string;
	artists: string[];
	album: string;
	duration: number;
	thumbnail: string;
}

export interface YTMusicCollectionSummary {
	id: string;
	title: string;
	subtitle: string;
	thumbnail: string;
	link: string;
}

export interface YTMusicLibrary {
	quickPicks: YTMusicTrack[];
	playlists: YTMusicCollectionSummary[];
	albums: YTMusicCollectionSummary[];
}

interface YTMusicConfig {
	cookie: string;
	accountName: string;
}

type LinkType = "quickpicks" | "library_songs" | "playlist" | "album";

/** Depth-first search for every object stored under `key` anywhere in `node`. */
export function findAll(node: any, key: string, results: any[] = []): any[] {
	if (Array.isArray(node)) {
		for (const child of node) findAll(child, key, results);
	} else if (node && typeof node === "object") {
		for (const [k, v] of Object.entries(node)) {
			if (k === key) results.push(v);
			else findAll(v, key, results);
		}
	}
	return results;
}

function runsText(text: any): string {
	return (text?.runs ?? []).map((run: any) => run.text).join("");
}

function lastThumbnail(node: any): string {
	const thumbnails = findAll(node, "thumbnails")[0] ?? [];
	return thumbnails.length ? thumbnails[thumbnails.length - 1].url : "";
}

function parseDuration(text: string): number {
	if (!/^\d+(:\d+)+$/.test(text)) return 0;
	return text
		.split(":")
		.reduce((total, part) => total * 60 + parseInt(part, 10), 0);
}

/** Strips YouTube-specific noise so the metadata has a chance on Deezer. */
export function cleanTitle(title: string): string {
	return title
		.replace(
			/[([](official\s*(music\s*)?(video|audio|lyric video|visualizer)|lyrics?|lyric video|audio|visualizer|hd|hq|4k|mv)[)\]]/gi,
			""
		)
		.replace(/\s{2,}/g, " ")
		.trim();
}

export function cleanArtist(artist: string): string {
	return artist
		.replace(/\s+-\s+Topic$/i, "")
		.replace(/VEVO$/, "")
		.trim();
}

/** Parses a `musicResponsiveListItemRenderer` row into a track. */
export function parseTrackRow(row: any): YTMusicTrack | null {
	const columns = (row.flexColumns ?? []).map(
		(column: any) => column.musicResponsiveListItemFlexColumnRenderer?.text
	);
	const videoId =
		row.playlistItemData?.videoId ??
		findAll(row, "watchEndpoint").find((endpoint) => endpoint?.videoId)
			?.videoId;
	if (!videoId || !columns.length) return null;

	const title = runsText(columns[0]);
	const artists: string[] = [];
	let album = "";

	for (const column of columns.slice(1)) {
		for (const run of column?.runs ?? []) {
			const pageType =
				run.navigationEndpoint?.browseEndpoint
					?.browseEndpointContextSupportedConfigs
					?.browseEndpointContextMusicConfig?.pageType;
			if (
				pageType === "MUSIC_PAGE_TYPE_ARTIST" ||
				pageType === "MUSIC_PAGE_TYPE_USER_CHANNEL"
			)
				artists.push(run.text);
			else if (pageType === "MUSIC_PAGE_TYPE_ALBUM") album = run.text;
		}
	}

	// Some rows (e.g. uploaded videos) have plain-text artists without links
	if (!artists.length && columns[1]) {
		const firstSegment = runsText(columns[1]).split(" • ")[0];
		if (firstSegment) artists.push(firstSegment);
	}

	const fixedText = runsText(
		row.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text
	);

	return {
		videoId,
		title,
		artists,
		album,
		duration: parseDuration(fixedText),
		thumbnail: lastThumbnail(row.thumbnail),
	};
}

/** Parses a `musicTwoRowItemRenderer` grid item into a playlist/album summary. */
export function parseCollectionItem(
	item: any
): YTMusicCollectionSummary | null {
	const browseId: string | undefined =
		item.navigationEndpoint?.browseEndpoint?.browseId;
	if (!browseId) return null;

	let id: string;
	let link: string;
	if (browseId.startsWith("MPREb")) {
		id = browseId;
		link = `${YTM_ORIGIN}/browse/${browseId}`;
	} else if (browseId.startsWith("VL")) {
		id = browseId.slice(2);
		link = `${YTM_ORIGIN}/playlist?list=${id}`;
	} else {
		return null;
	}

	return {
		id,
		title: runsText(item.title),
		subtitle: runsText(item.subtitle),
		thumbnail: lastThumbnail(item.thumbnailRenderer),
		link,
	};
}

export function extractSapisid(cookie: string): string | null {
	const match =
		/(?:^|;\s*)SAPISID=([^;]+)/.exec(cookie) ??
		/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/.exec(cookie);
	return match ? match[1].trim() : null;
}

export default class YTMusicPlugin extends BasePlugin {
	config: YTMusicConfig;
	enabled: boolean;
	configFolder: string;

	constructor(configFolder = undefined) {
		super();
		this.config = { cookie: "", accountName: "" };
		this.enabled = false;
		this.configFolder = configFolder || getConfigFolder();
		this.configFolder += `ytmusic${sep}`;
		return this;
	}

	override setup() {
		fs.mkdirSync(this.configFolder, { recursive: true });
		this.loadSettings();
		return this;
	}

	/* === Auth === */

	async login(rawCookie: string) {
		const cookie = rawCookie.replace(/^cookie:\s*/i, "").trim();
		if (!extractSapisid(cookie)) {
			throw new Error(
				"The cookie is missing SAPISID. Copy the full Cookie header from a logged-in music.youtube.com request."
			);
		}

		const previous = this.config;
		this.config = { cookie, accountName: "" };
		try {
			const accountName = await this.fetchAccountName();
			if (!accountName)
				throw new Error("YouTube Music did not accept the cookie.");
			this.config.accountName = accountName;
		} catch (e) {
			this.config = previous;
			throw e;
		}

		this.enabled = true;
		this.saveSettings();
		return this.getStatus();
	}

	logout() {
		this.config = { cookie: "", accountName: "" };
		this.enabled = false;
		this.saveSettings();
	}

	getStatus() {
		return { loggedIn: this.enabled, accountName: this.config.accountName };
	}

	async fetchAccountName(): Promise<string> {
		const response = await this.request("account/account_menu", {});
		const header = findAll(response, "activeAccountHeaderRenderer")[0];
		return runsText(header?.accountName);
	}

	/* === API === */

	clientVersion() {
		const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
		return `1.${date}.01.00`;
	}

	authHeaders() {
		const sapisid = extractSapisid(this.config.cookie);
		const timestamp = Math.floor(Date.now() / 1000);
		const hash = createHash("sha1")
			.update(`${timestamp} ${sapisid} ${YTM_ORIGIN}`)
			.digest("hex");

		return {
			"User-Agent": USER_AGENT,
			Accept: "*/*",
			"Content-Type": "application/json",
			Origin: YTM_ORIGIN,
			"X-Origin": YTM_ORIGIN,
			"X-Goog-AuthUser": "0",
			Cookie: this.config.cookie,
			Authorization: `SAPISIDHASH ${timestamp}_${hash}`,
		};
	}

	async request(endpoint: string, body: Record<string, any>): Promise<any> {
		return got
			.post(`${YTM_API}/${endpoint}?prettyPrint=false`, {
				headers: this.authHeaders(),
				json: {
					context: {
						client: {
							clientName: "WEB_REMIX",
							clientVersion: this.clientVersion(),
							hl: "en",
						},
						user: {},
					},
					...body,
				},
			})
			.json();
	}

	browse(browseId: string) {
		if (!this.enabled) throw new PluginNotEnabledError("YouTube Music");
		return this.request("browse", { browseId });
	}

	/**
	 * Returns every track in the first track shelf of a browse page, following
	 * continuations. Only tokens found inside the shelf are followed so that
	 * "suggestions"/"related" sections are not mixed in.
	 */
	async getShelfTracks(browseId: string): Promise<{
		response: any;
		tracks: YTMusicTrack[];
	}> {
		const response = await this.browse(browseId);
		const shelf =
			findAll(response, "musicPlaylistShelfRenderer")[0] ??
			findAll(response, "musicShelfRenderer")[0];
		if (!shelf) return { response, tracks: [] };

		const tracks: YTMusicTrack[] = [];
		let contents = shelf.contents ?? [];
		let token = this.continuationToken(shelf);

		for (let page = 0; page < MAX_PAGES; page++) {
			for (const item of contents) {
				const row = item.musicResponsiveListItemRenderer;
				const track = row && parseTrackRow(row);
				if (track) tracks.push(track);
			}
			token ??= this.continuationToken(contents);
			if (!token) break;

			const next = await this.request("browse", { continuation: token });
			const appended = findAll(next, "appendContinuationItemsAction")[0];
			const legacy =
				next?.continuationContents?.musicPlaylistShelfContinuation ??
				next?.continuationContents?.musicShelfContinuation;

			contents = appended?.continuationItems ?? legacy?.contents ?? [];
			token = legacy ? this.continuationToken(legacy) : undefined;
		}

		return { response, tracks };
	}

	continuationToken(node: any): string | undefined {
		// Only look at direct children: `contents[]` items or `continuations[]`
		const items: any[] = Array.isArray(node)
			? node
			: (node?.continuations ?? []);
		for (const item of items) {
			const token =
				item?.continuationItemRenderer?.continuationEndpoint
					?.continuationCommand?.token ??
				item?.nextContinuationData?.continuation;
			if (token) return token;
		}
		return undefined;
	}

	async getQuickPicks(): Promise<YTMusicTrack[]> {
		const response = await this.browse("FEmusic_home");
		const shelf = findAll(response, "musicCarouselShelfRenderer").find(
			(carousel) =>
				/quick picks/i.test(
					runsText(
						carousel.header?.musicCarouselShelfBasicHeaderRenderer?.title
					)
				)
		);
		if (!shelf) return [];

		return findAll(shelf.contents, "musicResponsiveListItemRenderer")
			.map(parseTrackRow)
			.filter(Boolean);
	}

	async getLibraryCollections(
		browseId: string
	): Promise<YTMusicCollectionSummary[]> {
		const response = await this.browse(browseId);
		return findAll(response, "musicTwoRowItemRenderer")
			.map(parseCollectionItem)
			.filter(Boolean);
	}

	async getLibrary(): Promise<YTMusicLibrary> {
		const [quickPicks, playlists, albums] = await Promise.all([
			this.getQuickPicks(),
			this.getLibraryCollections("FEmusic_liked_playlists"),
			this.getLibraryCollections("FEmusic_liked_albums"),
		]);

		// "Liked music" isn't always listed in the library grid
		if (!playlists.some((playlist) => playlist.id === "LM")) {
			playlists.unshift({
				id: "LM",
				title: "Liked Music",
				subtitle: "Auto playlist",
				thumbnail: "",
				link: `${YTM_ORIGIN}/playlist?list=LM`,
			});
		}

		return { quickPicks, playlists, albums };
	}

	/* === Download objects === */

	override async parseLink(link: string) {
		if (link === YTM_QUICK_PICKS_LINK)
			return [link, "quickpicks", "quickpicks"];
		if (!link.includes("music.youtube.com"))
			return [link, undefined, undefined];

		let url: URL;
		try {
			url = new URL(link);
		} catch {
			return [link, undefined, undefined];
		}

		let linkType: LinkType | undefined;
		let linkId: string | undefined;

		if (url.pathname.startsWith("/library/songs")) {
			linkType = "library_songs";
			linkId = "library_songs";
		} else if (url.pathname === "/playlist" && url.searchParams.get("list")) {
			linkType = "playlist";
			linkId = url.searchParams.get("list");
		} else if (url.pathname.startsWith("/browse/MPREb")) {
			linkType = "album";
			linkId = url.pathname.split("/")[2];
		}

		return [link, linkType, linkId];
	}

	override async generateDownloadObject(
		dz: Deezer,
		link: string,
		bitrate: number
	) {
		const [, linkType, linkId] = await this.parseLink(link);
		if (!linkType || !linkId) return null;
		if (!this.enabled) throw new PluginNotEnabledError("YouTube Music");

		let title: string;
		let owner = this.config.accountName || "YouTube Music";
		let cover = "";
		let tracks: YTMusicTrack[];

		switch (linkType as LinkType) {
			case "quickpicks":
				title = "Quick picks";
				tracks = await this.getQuickPicks();
				break;
			case "library_songs":
				title = "Library songs";
				({ tracks } = await this.getShelfTracks("FEmusic_liked_videos"));
				break;
			case "playlist":
			case "album": {
				const browseId = linkType === "album" ? linkId : `VL${linkId}`;
				const result = await this.getShelfTracks(browseId);
				tracks = result.tracks;

				const header =
					findAll(result.response, "musicResponsiveHeaderRenderer")[0] ??
					findAll(result.response, "musicDetailHeaderRenderer")[0] ??
					findAll(
						result.response,
						"musicEditablePlaylistDetailHeaderRenderer"
					)[0];
				title =
					runsText(header?.title) || (linkId === "LM" ? "Liked Music" : linkId);
				cover = lastThumbnail(header?.thumbnail);
				const strapline =
					runsText(header?.straplineTextOne) || runsText(header?.subtitle);
				if (strapline) owner = strapline.split(" • ").pop();

				// Album rows omit artist/album, so fill them from the header
				if (linkType === "album") {
					for (const track of tracks) {
						if (!track.album) track.album = title;
						if (!track.artists.length && strapline) track.artists = [owner];
					}
				}
				break;
			}
		}

		cover ||= tracks[0]?.thumbnail ?? "";
		const playlistAPI: any = this._convertPlaylistStructure({
			id: linkId,
			title,
			owner,
			cover,
			link: linkType === "quickpicks" ? YTM_ORIGIN : link,
			size: tracks.length,
		});
		playlistAPI.various_artist = await dz.api.get_artist(5080); // Useful for save as compilation
		playlistAPI.explicit = false;

		return new Convertable({
			type: "ytmusic_playlist",
			// Quick picks change over time, so give each snapshot its own queue entry
			id: linkType === "quickpicks" ? `quickpicks_${Date.now()}` : linkId,
			bitrate,
			title,
			artist: owner,
			cover: playlistAPI.picture_thumbnail,
			explicit: false,
			size: tracks.length,
			collection: {
				tracks: [],
				playlistAPI,
			},
			plugin: "ytmusic",
			conversion_data: tracks,
		});
	}

	async convert(
		dz: Deezer,
		downloadObject: Convertable,
		settings: Settings,
		listener: any = null
	): Promise<Collection> {
		const cache = this.loadCache();
		const tracks = downloadObject.conversionData as unknown as YTMusicTrack[];
		const collection = [];
		let conversion = 0;
		let conversionNext = 0;

		if (listener)
			listener.send("startConversion", {
				uuid: downloadObject.uuid,
				title: downloadObject.title,
			});

		const q = queue(async (data: { track: YTMusicTrack; pos: number }) => {
			const { track, pos } = data;
			if (downloadObject.isCanceled) return;

			const artist = cleanArtist(track.artists[0] ?? "");
			const title = cleanTitle(track.title);

			let deezerId: string = cache.tracks[track.videoId];
			if (deezerId === undefined) {
				try {
					deezerId = String(
						await dz.api.get_track_id_from_metadata(artist, title, track.album)
					);
				} catch {
					deezerId = "0";
				}
				cache.tracks[track.videoId] = deezerId;
			}

			let trackAPI: any = null;
			if (deezerId !== "0") {
				try {
					trackAPI = await dz.api.getTrack(deezerId);
				} catch {
					/* empty */
				}
			}

			trackAPI ??= {
				id: 0,
				title: track.title,
				duration: track.duration,
				md5_origin: 0,
				media_version: 0,
				filesizes: {},
				album: { title: track.album, md5_image: "" },
				artist: { id: 0, name: artist, md5_image: "" },
			};

			trackAPI.position = pos + 1;
			collection[pos] = trackAPI;

			conversionNext += (1 / downloadObject.size) * 100;
			if (
				Math.round(conversionNext) !== conversion &&
				Math.round(conversionNext) % 10 === 0 &&
				Math.round(conversionNext) !== 100
			) {
				conversion = Math.round(conversionNext);
				if (listener)
					listener.send("updateQueue", {
						uuid: downloadObject.uuid,
						title: downloadObject.title,
						conversion,
					});
			}
		}, settings.queueConcurrency);

		tracks.forEach((track, pos) => q.push({ track, pos }));
		if (tracks.length) await q.drain();

		downloadObject.collection.tracks = collection;
		downloadObject.size = collection.length;

		const returnCollection = new Collection(downloadObject.toDict());
		if (listener)
			listener.send("finishConversion", returnCollection.getSlimmedDict());

		this.saveCache(cache);
		return returnCollection;
	}

	_convertPlaylistStructure(playlist: {
		id: string;
		title: string;
		owner: string;
		cover: string;
		link: string;
		size: number;
	}) {
		const fallback = (size: string) =>
			`https://e-cdns-images.dzcdn.net/images/cover/d41d8cd98f00b204e9800998ecf8427e/${size}-000000-80-0-0.jpg`;

		return {
			checksum: "",
			collaborative: false,
			creation_date: "XXXX-00-00",
			creator: {
				id: playlist.owner,
				name: playlist.owner,
				tracklist: "",
				type: "user",
			},
			description: "",
			duration: 0,
			fans: 0,
			id: playlist.id,
			is_loved_track: false,
			link: playlist.link,
			nb_tracks: playlist.size,
			picture: playlist.cover || null,
			picture_small: playlist.cover || fallback("56x56"),
			picture_medium: playlist.cover || fallback("250x250"),
			picture_big: playlist.cover || fallback("500x500"),
			picture_xl: playlist.cover || fallback("1000x1000"),
			picture_thumbnail: playlist.cover || fallback("75x75"),
			public: false,
			share: playlist.link,
			title: playlist.title,
			tracklist: "",
			type: "playlist",
		};
	}

	/* === Persistence === */

	loadSettings() {
		try {
			const saved = JSON.parse(
				fs.readFileSync(this.configFolder + "config.json").toString()
			);
			this.config = {
				cookie: saved.cookie ?? "",
				accountName: saved.accountName ?? "",
			};
		} catch {
			this.saveSettings();
		}
		this.enabled = !!this.config.cookie && !!extractSapisid(this.config.cookie);
	}

	saveSettings() {
		fs.writeFileSync(
			this.configFolder + "config.json",
			JSON.stringify(this.config, null, 2),
			{ mode: 0o600 }
		);
	}

	loadCache(): { tracks: Record<string, string> } {
		try {
			const cache = JSON.parse(
				fs.readFileSync(this.configFolder + "cache.json").toString()
			);
			return { tracks: cache.tracks ?? {} };
		} catch {
			return { tracks: {} };
		}
	}

	saveCache(cache: { tracks: Record<string, string> }) {
		fs.writeFileSync(this.configFolder + "cache.json", JSON.stringify(cache));
	}
}
