import {callFf} from './call-ffmpeg';
import type {Codec} from './codec';
import {DEFAULT_CODEC} from './codec';
import {generateFfmpegArgs} from './ffmpeg-args';
import type {FfmpegOverrideFn} from './ffmpeg-override';
import {getProResProfileName} from './get-prores-profile-name';
import type {VideoImageFormat} from './image-format';
import type {LogLevel} from './log-level';
import {Log} from './logger';
import type {CancelSignal} from './make-cancel-signal';
import type {ColorSpace} from './options/color-space';
import {parseFfmpegProgress} from './parse-ffmpeg-progress';
import type {PixelFormat} from './pixel-format';
import {
	DEFAULT_PIXEL_FORMAT,
	validateSelectedPixelFormatAndCodecCombination,
} from './pixel-format';
import type {ProResProfile} from './prores-profile';
import {validateDimension, validateFps} from './validate';
import {validateEvenDimensionsWithCodec} from './validate-even-dimensions-with-codec';
import type {X264Preset} from './x264-preset';

type RunningStatus =
	| {
			type: 'running';
	  }
	| {
			type: 'quit-successfully';
			stderr: string;
	  }
	| {
			type: 'quit-with-error';
			exitCode: number;
			stderr: string;
	  };

type PreStitcherOptions = {
	fps: number;
	width: number;
	height: number;
	outputLocation: string;
	pixelFormat: PixelFormat | undefined;
	codec: Codec | undefined;
	crf: number | null | undefined;
	x264Preset: X264Preset | null;
	onProgress: (progress: number) => void;
	proResProfile: ProResProfile | undefined;
	logLevel: LogLevel;
	imageFormat: VideoImageFormat;
	ffmpegOverride: FfmpegOverrideFn;
	signal: CancelSignal;
	videoBitrate: string | null;
	indent: boolean;
	colorSpace: ColorSpace;
};

export const prespawnFfmpeg = (options: PreStitcherOptions) => {
	validateDimension(
		options.height,
		'height',
		'passed to `stitchFramesToVideo()`',
	);
	validateDimension(
		options.width,
		'width',
		'passed to `stitchFramesToVideo()`',
	);
	const codec = options.codec ?? DEFAULT_CODEC;
	validateFps(options.fps, 'in `stitchFramesToVideo()`', codec === 'gif');
	validateEvenDimensionsWithCodec({
		width: options.width,
		height: options.height,
		codec,
		scale: 1,
		wantsImageSequence: false,
	});
	const pixelFormat = options.pixelFormat ?? DEFAULT_PIXEL_FORMAT;

	const proResProfileName = getProResProfileName(codec, options.proResProfile);

	validateSelectedPixelFormatAndCodecCombination(pixelFormat, codec);

	const ffmpegArgs = [
		['-r', options.fps],
		...[
			['-f', 'image2pipe'],
			['-s', `${options.width}x${options.height}`],
			// If scale is very small (like 0.1), FFMPEG cannot figure out the image
			// format on it's own and we need to hint the format
			['-vcodec', options.imageFormat === 'jpeg' ? 'mjpeg' : 'png'],
			['-i', '-'],
		],
		...generateFfmpegArgs({
			hasPreencoded: false,
			proResProfileName,
			pixelFormat,
			x264Preset: options.x264Preset,
			codec,
			crf: options.crf,
			videoBitrate: options.videoBitrate,
			colorSpace: options.colorSpace,
		}),

		'-y',
		options.outputLocation,
	];

	Log.verboseAdvanced(
		{
			indent: options.indent,
			logLevel: options.logLevel,
			tag: 'prespawnFfmpeg()',
		},
		'Generated FFMPEG command:',
	);
	Log.verboseAdvanced(
		{
			indent: options.indent,
			logLevel: options.logLevel,
			tag: 'prespawnFfmpeg()',
		},
		ffmpegArgs.join(' '),
	);

	const ffmpegString = ffmpegArgs.flat(2).filter(Boolean) as string[];
	const finalFfmpegString = options.ffmpegOverride
		? options.ffmpegOverride({type: 'pre-stitcher', args: ffmpegString})
		: ffmpegString;

	const task = callFf(
		'ffmpeg',
		finalFfmpegString,
		options.indent,
		options.logLevel,
	);

	options.signal(() => {
		task.kill();
	});

	let ffmpegOutput = '';
	task.stderr?.on('data', (data: Buffer) => {
		const str = data.toString();
		ffmpegOutput += str;
		if (options.onProgress) {
			const parsed = parseFfmpegProgress(str);
			if (parsed !== undefined) {
				options.onProgress(parsed);
			}
		}
	});

	let exitCode: RunningStatus = {
		type: 'running',
	};

	task.on('exit', (code) => {
		if (typeof code === 'number' && code > 0) {
			exitCode = {
				type: 'quit-with-error',
				exitCode: code,
				stderr: ffmpegOutput,
			};
		} else {
			exitCode = {
				type: 'quit-successfully',
				stderr: ffmpegOutput,
			};
		}
	});

	return {task, getLogs: () => ffmpegOutput, getExitStatus: () => exitCode};
};
