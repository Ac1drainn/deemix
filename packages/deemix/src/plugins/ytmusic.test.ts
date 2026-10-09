import { describe, expect, it } from "vitest";

import YTMusicPlugin, {
	cleanArtist,
	cleanTitle,
	extractSapisid,
	parseCollectionItem,
	parseTrackRow,
} from "./ytmusic.js";

const browseRun = (text: string, pageType: string) => ({
	text,
	navigationEndpoint: {
		browseEndpoint: {
			browseEndpointContextSupportedConfigs: {
				browseEndpointContextMusicConfig: { pageType },
			},
		},
	},
});

describe("YTMusicPlugin.parseLink", () => {
	const plugin = new YTMusicPlugin("/tmp/deemix-ytmusic-test/");

	it.each([
		["ytmusic:quickpicks", "quickpicks", "quickpicks"],
		[
			"https://music.youtube.com/library/songs",
			"library_songs",
			"library_songs",
		],
		["https://music.youtube.com/playlist?list=PL123&si=x", "playlist", "PL123"],
		["https://music.youtube.com/playlist?list=LM", "playlist", "LM"],
		["https://music.youtube.com/browse/MPREb_abc", "album", "MPREb_abc"],
	])("parses %s", async (link, type, id) => {
		const [, linkType, linkId] = await plugin.parseLink(link);
		expect(linkType).toBe(type);
		expect(linkId).toBe(id);
	});

	it("ignores non YouTube Music links", async () => {
		const [, linkType] = await plugin.parseLink(
			"https://www.deezer.com/track/1"
		);
		expect(linkType).toBeUndefined();
	});
});

describe("parseTrackRow", () => {
	it("extracts title, artists, album and duration", () => {
		const track = parseTrackRow({
			playlistItemData: { videoId: "vid1" },
			flexColumns: [
				{
					musicResponsiveListItemFlexColumnRenderer: {
						text: { runs: [{ text: "Song" }] },
					},
				},
				{
					musicResponsiveListItemFlexColumnRenderer: {
						text: {
							runs: [
								browseRun("Artist A", "MUSIC_PAGE_TYPE_ARTIST"),
								{ text: " & " },
								browseRun("Artist B", "MUSIC_PAGE_TYPE_ARTIST"),
								{ text: " • " },
								browseRun("The Album", "MUSIC_PAGE_TYPE_ALBUM"),
							],
						},
					},
				},
			],
			fixedColumns: [
				{
					musicResponsiveListItemFixedColumnRenderer: {
						text: { runs: [{ text: "3:25" }] },
					},
				},
			],
		});

		expect(track).toMatchObject({
			videoId: "vid1",
			title: "Song",
			artists: ["Artist A", "Artist B"],
			album: "The Album",
			duration: 205,
		});
	});

	it("falls back to plain-text artist and returns null without a videoId", () => {
		const columns = [
			{
				musicResponsiveListItemFlexColumnRenderer: {
					text: { runs: [{ text: "Clip" }] },
				},
			},
			{
				musicResponsiveListItemFlexColumnRenderer: {
					text: { runs: [{ text: "Uploader • 1.2M views" }] },
				},
			},
		];

		expect(parseTrackRow({ flexColumns: columns })).toBeNull();
		expect(
			parseTrackRow({
				flexColumns: columns,
				overlay: { watchEndpoint: { videoId: "vid2" } },
			})?.artists
		).toEqual(["Uploader"]);
	});
});

describe("parseCollectionItem", () => {
	it("maps playlist and album browse ids to links", () => {
		expect(
			parseCollectionItem({
				title: { runs: [{ text: "Mix" }] },
				navigationEndpoint: { browseEndpoint: { browseId: "VLPL9" } },
			})?.link
		).toBe("https://music.youtube.com/playlist?list=PL9");
		expect(
			parseCollectionItem({
				navigationEndpoint: { browseEndpoint: { browseId: "MPREb_x" } },
			})?.link
		).toBe("https://music.youtube.com/browse/MPREb_x");
		expect(
			parseCollectionItem({
				navigationEndpoint: { browseEndpoint: { browseId: "UC123" } },
			})
		).toBeNull();
	});
});

describe("helpers", () => {
	it("extracts SAPISID from a cookie header", () => {
		expect(extractSapisid("a=1; SAPISID=abc/def; b=2")).toBe("abc/def");
		expect(extractSapisid("__Secure-3PAPISID=xyz")).toBe("xyz");
		expect(extractSapisid("a=1")).toBeNull();
	});

	it("cleans YouTube noise from titles and artists", () => {
		expect(cleanTitle("Song (Official Music Video)")).toBe("Song");
		expect(cleanTitle("Song [Lyrics]")).toBe("Song");
		expect(cleanTitle("Song (Remix)")).toBe("Song (Remix)");
		expect(cleanArtist("Artist - Topic")).toBe("Artist");
		expect(cleanArtist("ArtistVEVO")).toBe("Artist");
	});
});
