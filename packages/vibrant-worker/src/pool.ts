import Bluebird = require('bluebird')
import omit = require('lodash/omit')
import find = require('lodash/find')
import {
    DeferredBluebird,
    defer
} from 'vibrant-types'
import { TaskWorker, TaskWorkerClass } from './'

import {
    WorkerRequest,
    WorkerResponse,
    WorkerErrorResponse
} from './common'

interface Task<R> extends WorkerRequest {
    deferred: DeferredBluebird<R>
}

// const WorkerClass: TaskWorkerClass = require('worker-loader?inline=true!./worker')

const MAX_WORKER_COUNT = 5
export default class WorkerPool {
    private _taskId = 0

    private _workers: TaskWorker[] = []
    private _queue: Task<{}>[] = []
    private _executing: { [id: number]: Task<{}> } = {}

    constructor(public WorkerClass: TaskWorkerClass) {

    }

    private _findIdleWorker(): TaskWorker {
        let worker: TaskWorker
        // if no idle worker && worker count < max count, make new one
        if (this._workers.length === 0 || this._workers.length < MAX_WORKER_COUNT) {
            worker = new this.WorkerClass()
            worker.id = this._workers.length
            worker.idle = true
            this._workers.push(worker)
            worker.onmessage = this._onMessage.bind(this, worker.id)
        } else {
            worker = find(this._workers, 'idle')
        }

        return worker
    }

    private _enqueue<R>(payload: any[], transferList: any[]): Bluebird<R> {
        let d = defer<R>()

        // make task item
        let task: Task<R> = {
            id: this._taskId++,
            payload,
            transferList,
            deferred: d
        }
        this._queue.push(task)

        // Try dequeue
        this._tryDequeue()

        return d.promise
    }

    private _tryDequeue() {
        // Called when a work has finished or from _enqueue

        // No pending task
        if (this._queue.length <= 0) return

        // Find idle worker
        let worker = this._findIdleWorker()
        // No idle worker
        if (!worker) return

        // Dequeue task
        let task = this._queue.shift()
        this._executing[task.id] = task

        // Send payload
        let transfers = task.transferList
        let request = <WorkerRequest>omit(task, 'deferred', 'transferList')
        worker.postMessage(request, transfers)
        worker.idle = false
    }
    private _onMessage(workerId: number, event: MessageEvent) {
        let data: WorkerResponse<{}> | WorkerErrorResponse = event.data
        if (!data) return
        // Worker should send result along with payload id
        let { id } = data
        // Task is looked up by id
        let task = this._executing[id]
        this._executing[id] = undefined

        // Resolve or reject deferred promise
        switch (data.type) {
            case 'return':
                task.deferred.resolve(data.payload)
                break
            case 'error':
                task.deferred.reject(new Error(data.payload))
                break
        }
        // Update worker status
        this._workers[workerId].idle = true
        // Try dequeue next task
        this._tryDequeue()
    }
    invoke<R>(args: any[], transferList: any[]): Bluebird<R> {
        return this._enqueue(args, transferList)
    }
}